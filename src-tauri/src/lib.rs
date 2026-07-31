use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use flate2::read::GzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const API_BASE: &str = "https://iptv-org.github.io/api";
const DEFAULT_PLAYLIST: &str = "https://iptv-org.github.io/iptv/index.m3u";
const CATALOG_CACHE_FILE: &str = "iptv-org-catalog-v3.json";
const LEGACY_CATALOG_CACHE_FILE: &str = "iptv-org-catalog-v2.json";
const OPTIONAL_FAST_PLAYLISTS: &[&str] = &[
    "https://www.apsattv.com/ssungaus.m3u",
    "https://www.apsattv.com/ssungnz.m3u",
    "https://www.apsattv.com/ssungph.m3u",
    "https://www.apsattv.com/ssungsg.m3u",
    "https://www.apsattv.com/ssungth.m3u",
];
const ANI_ONE_DEAD_URL: &str = "https://amg19223-amg19223c9-amgplt0019.playout.now3.amagi.tv/playlist/amg19223-amg19223c9-amgplt0019/playlist.m3u8";
const ANI_ONE_CURRENT_URL: &str = "https://amg19223-amg19223c9-amgplt0352.playout.now3.amagi.tv/playlist/amg19223-amg19223c9-amgplt0352/playlist.m3u8";
const USER_AGENT: &str = "CrowFlix/0.5 (+https://github.com/CrowLoki/Crow-Flix)";
const MAX_EXTERNAL_URL_LENGTH: usize = 8_192;
const MAX_CATALOG_LARGE_JSON_BYTES: usize = 32 * 1024 * 1024;
const MAX_CATALOG_METADATA_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_CATALOG_GUIDES_JSON_BYTES: usize = 64 * 1024 * 1024;
const MAX_OPTIONAL_FAST_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_PLAYLIST_BYTES: usize = 16 * 1024 * 1024;
const MAX_PLAYLIST_ENTRIES: usize = 50_000;
const MAX_PLAYLIST_SOURCES_PER_CHANNEL: usize = 256;
const MAX_XMLTV_TRANSFER_BYTES: usize = 128 * 1024 * 1024;
const MAX_XMLTV_GZIP_BYTES: usize = 64 * 1024 * 1024;
const MAX_XMLTV_BYTES: usize = 128 * 1024 * 1024;
const MAX_XMLTV_CHANNEL_IDS: usize = 100_000;
const MAX_XMLTV_PROGRAMMES: usize = 250_000;
const MAX_XMLTV_TITLE_BYTES: usize = 1024;
const MAX_XMLTV_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_XMLTV_CATEGORY_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    key: String,
    id: String,
    feed: Option<String>,
    name: String,
    logo: Option<String>,
    categories: Vec<String>,
    country: Option<String>,
    languages: Vec<String>,
    broadcast_area: Vec<String>,
    #[serde(default)]
    sources: Vec<StreamSource>,
    // These fields mirror the preferred source so older frontends and caches remain readable.
    url: String,
    referrer: Option<String>,
    user_agent: Option<String>,
    quality: Option<String>,
    label: Option<String>,
    format: Option<String>,
    network: Option<String>,
    website: Option<String>,
    is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StreamSource {
    id: String,
    title: Option<String>,
    url: String,
    referrer: Option<String>,
    user_agent: Option<String>,
    quality: Option<String>,
    label: Option<String>,
    transport: StreamTransport,
    is_https: bool,
    requires_headers: bool,
    preference_score: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum StreamTransport {
    Hls,
    Dash,
    Direct,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamedOption {
    id: String,
    name: String,
    description: Option<String>,
    count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountryOption {
    code: String,
    name: String,
    flag: String,
    languages: Vec<String>,
    count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegionOption {
    code: String,
    name: String,
    countries: Vec<String>,
    count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    channels: Vec<Channel>,
    categories: Vec<NamedOption>,
    countries: Vec<CountryOption>,
    languages: Vec<NamedOption>,
    regions: Vec<RegionOption>,
    updated_at: String,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Programme {
    channel_id: String,
    title: String,
    description: Option<String>,
    category: Option<String>,
    start: String,
    stop: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuideResult {
    programmes: Vec<Programme>,
    source: String,
    matched_channels: usize,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ApiChannel {
    id: String,
    name: String,
    network: Option<String>,
    country: String,
    #[serde(default)]
    categories: Vec<String>,
    closed: Option<String>,
    website: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiFeed {
    channel: String,
    id: String,
    name: String,
    #[serde(default)]
    is_main: bool,
    #[serde(default)]
    broadcast_area: Vec<String>,
    #[serde(default)]
    languages: Vec<String>,
    format: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiLogo {
    channel: String,
    feed: Option<String>,
    #[serde(default)]
    in_use: bool,
    url: String,
}

#[derive(Debug, Deserialize)]
struct ApiStream {
    channel: Option<String>,
    feed: Option<String>,
    title: String,
    url: String,
    quality: Option<String>,
    label: Option<String>,
    user_agent: Option<String>,
    referrer: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiCategory {
    id: String,
    name: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct ApiLanguage {
    code: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct ApiCountry {
    name: String,
    code: String,
    #[serde(default)]
    languages: Vec<String>,
    flag: String,
}

#[derive(Debug, Deserialize)]
struct ApiRegion {
    code: String,
    name: String,
    #[serde(default)]
    countries: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ApiBlock {
    channel: String,
}

#[derive(Debug, Deserialize)]
struct ApiGuideSource {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ApiGuide {
    channel: Option<String>,
    #[serde(default)]
    sources: Vec<ApiGuideSource>,
}

fn trim_wrapping_quotes(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].trim();
        }
    }
    value
}

fn normalize_plain_text(value: Option<String>, max_len: usize) -> Option<String> {
    let value = value?;
    let value = trim_wrapping_quotes(&value);
    if value.is_empty()
        || value.len() > max_len
        || value.chars().any(|character| character.is_control())
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_user_agent(value: Option<String>) -> Option<String> {
    let mut value = normalize_plain_text(value, 768)?;
    loop {
        let lower = value.to_ascii_lowercase();
        let prefix_length = [
            "#extvlcopt:http-user-agent=",
            "http-user-agent=",
            "user-agent=",
        ]
        .iter()
        .find_map(|prefix| lower.starts_with(prefix).then_some(prefix.len()));
        let Some(prefix_length) = prefix_length else {
            break;
        };
        value = trim_wrapping_quotes(&value[prefix_length..]).to_string();
    }
    normalize_plain_text(Some(value), 512).filter(|value| value.is_ascii())
}

fn normalize_http_url(value: &str) -> Option<(String, bool)> {
    let value = trim_wrapping_quotes(value);
    if value.is_empty()
        || value.len() > 8_192
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }

    let lower = value.to_ascii_lowercase();
    let (authority_start, is_https) = if lower.starts_with("https://") {
        (8, true)
    } else if lower.starts_with("http://") {
        (7, false)
    } else {
        return None;
    };
    let remainder = &value[authority_start..];
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((value.to_string(), is_https))
}

fn normalize_referrer(value: Option<String>) -> Option<String> {
    let value = normalize_plain_text(value, 2_048)?;
    if !value.is_ascii() {
        return None;
    }
    normalize_http_url(&value).map(|(url, _)| url)
}

fn stream_transport(url: &str) -> StreamTransport {
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    if path.ends_with(".m3u8") || path.ends_with(".m3u") {
        StreamTransport::Hls
    } else if path.ends_with(".mpd") {
        StreamTransport::Dash
    } else if [
        ".mp4", ".m4v", ".webm", ".ts", ".m2ts", ".aac", ".m4a", ".mp3", ".ogg", ".oga",
    ]
    .iter()
    .any(|extension| path.ends_with(extension))
    {
        StreamTransport::Direct
    } else {
        StreamTransport::Unknown
    }
}

fn quality_height(quality: Option<&str>) -> u16 {
    let Some(quality) = quality else {
        return 0;
    };
    let lower = quality.to_ascii_lowercase();
    if lower.contains("4k") || lower.contains("uhd") {
        return 2_160;
    }
    if lower.contains("fhd") {
        return 1_080;
    }
    if lower == "hd" {
        return 720;
    }
    if lower == "sd" {
        return 480;
    }
    let digits: String = lower
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits
        .parse::<u16>()
        .ok()
        .filter(|height| (100..=4_320).contains(height))
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceAvailability {
    Normal,
    PartTime,
    GeoBlocked,
}

fn label_words(label: &str) -> Vec<String> {
    label
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn source_availability(label: Option<&str>) -> SourceAvailability {
    let Some(label) = label else {
        return SourceAvailability::Normal;
    };
    let words = label_words(label);
    let is_geo_blocked = words.windows(2).enumerate().any(|(index, phrase)| {
        phrase == ["geo", "blocked"]
            && (index == 0 || !matches!(words[index - 1].as_str(), "non" | "not"))
    });
    if is_geo_blocked {
        return SourceAvailability::GeoBlocked;
    }
    let is_part_time = words.windows(3).any(|phrase| phrase == ["not", "24", "7"])
        || words
            .windows(3)
            .any(|phrase| phrase == ["not", "always", "on"])
        || words.windows(2).any(|phrase| phrase == ["not", "24x7"]);
    if is_part_time {
        SourceAvailability::PartTime
    } else {
        SourceAvailability::Normal
    }
}

fn source_preference_score(source: &StreamSource) -> u16 {
    let transport_score = match source.transport {
        StreamTransport::Hls => 400,
        StreamTransport::Direct => 300,
        StreamTransport::Unknown => 200,
        StreamTransport::Dash => 100,
    };
    let https_score = if source.is_https { 40 } else { 0 };
    let quality_score = (quality_height(source.quality.as_deref()) / 60).min(72);
    let availability_score = match source_availability(source.label.as_deref()) {
        SourceAvailability::Normal => 2_000,
        SourceAvailability::PartTime => 1_000,
        SourceAvailability::GeoBlocked => 0,
    };
    availability_score + transport_score + https_score + quality_score
}

fn stable_hash(value: &str) -> u64 {
    // FNV-1a is deliberately simple and deterministic; this ID is not a security token.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn source_id(url: &str, user_agent: Option<&str>, referrer: Option<&str>) -> String {
    let identity = format!(
        "{url}\n{}\n{}",
        user_agent.unwrap_or_default(),
        referrer.unwrap_or_default()
    );
    format!("source-{:016x}", stable_hash(&identity))
}

fn make_stream_source(
    title: Option<String>,
    url: String,
    referrer: Option<String>,
    user_agent: Option<String>,
    quality: Option<String>,
    label: Option<String>,
) -> Option<StreamSource> {
    let (url, is_https) = normalize_http_url(&url)?;
    let referrer = normalize_referrer(referrer);
    let user_agent = normalize_user_agent(user_agent);
    let quality = normalize_plain_text(quality, 64);
    let label = normalize_plain_text(label, 128);
    let title = normalize_plain_text(title, 256);
    let transport = stream_transport(&url);
    let requires_headers = referrer.is_some() || user_agent.is_some();
    let id = source_id(&url, user_agent.as_deref(), referrer.as_deref());
    let mut source = StreamSource {
        id,
        title,
        url,
        referrer,
        user_agent,
        quality,
        label,
        transport,
        is_https,
        requires_headers,
        preference_score: 0,
    };
    source.preference_score = source_preference_score(&source);
    Some(source)
}

fn logical_channel_key(id: &str, feed: Option<&str>) -> String {
    format!("{id}@{}", feed.unwrap_or("main"))
}

fn channel_is_closed(closed: Option<&str>, today: NaiveDate) -> bool {
    closed
        .and_then(|value| NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok())
        .is_some_and(|date| date <= today)
}

fn split_channel_feed(id: &str) -> (String, Option<String>) {
    match id.split_once('@') {
        Some((channel, feed)) if !channel.trim().is_empty() && !feed.trim().is_empty() => {
            (channel.trim().to_string(), Some(feed.trim().to_string()))
        }
        _ => (id.trim().to_string(), None),
    }
}

fn compare_sources(left: &StreamSource, right: &StreamSource) -> std::cmp::Ordering {
    right
        .preference_score
        .cmp(&left.preference_score)
        .then_with(|| {
            quality_height(right.quality.as_deref()).cmp(&quality_height(left.quality.as_deref()))
        })
        .then_with(|| left.id.cmp(&right.id))
}

fn choose_text(current: &mut Option<String>, candidate: Option<String>) {
    let Some(candidate) = candidate.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let replace = current.as_ref().is_none_or(|existing| {
        candidate
            .to_ascii_lowercase()
            .cmp(&existing.to_ascii_lowercase())
            .then_with(|| candidate.cmp(existing))
            .is_lt()
    });
    if replace {
        *current = Some(candidate);
    }
}

fn merge_source(target: &mut StreamSource, candidate: StreamSource) {
    choose_text(&mut target.title, candidate.title);
    choose_text(&mut target.quality, candidate.quality);
    choose_text(&mut target.label, candidate.label);
    target.preference_score = source_preference_score(target);
}

fn add_source(channel: &mut Channel, source: StreamSource) {
    if let Some(existing) = channel
        .sources
        .iter_mut()
        .find(|existing| existing.id == source.id)
    {
        merge_source(existing, source);
    } else {
        channel.sources.push(source);
    }
}

fn sort_and_sync_sources(channel: &mut Channel) {
    channel.sources.sort_by(compare_sources);
    if let Some(source) = channel.sources.first() {
        channel.url.clone_from(&source.url);
        channel.referrer.clone_from(&source.referrer);
        channel.user_agent.clone_from(&source.user_agent);
        channel.quality.clone_from(&source.quality);
        channel.label.clone_from(&source.label);
    }
}

fn merge_unique(values: &mut Vec<String>, candidates: Vec<String>) {
    for candidate in candidates {
        if !values
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&candidate))
        {
            values.push(candidate);
        }
    }
    values.sort_by(|left, right| {
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(right))
    });
}

fn choose_name(current: &mut String, candidate: String) {
    if current.is_empty()
        || candidate
            .to_ascii_lowercase()
            .cmp(&current.to_ascii_lowercase())
            .then_with(|| candidate.cmp(current))
            .is_lt()
    {
        *current = candidate;
    }
}

fn normalize_channel_sources(channel: &mut Channel) {
    let existing_sources = std::mem::take(&mut channel.sources);
    if existing_sources.is_empty() {
        if let Some(source) = make_stream_source(
            None,
            channel.url.clone(),
            channel.referrer.clone(),
            channel.user_agent.clone(),
            channel.quality.clone(),
            channel.label.clone(),
        ) {
            add_source(channel, source);
        }
    } else {
        for source in existing_sources {
            if let Some(source) = make_stream_source(
                source.title,
                source.url,
                source.referrer,
                source.user_agent,
                source.quality,
                source.label,
            ) {
                add_source(channel, source);
            }
        }
    }
    sort_and_sync_sources(channel);
}

fn merge_channel(target: &mut Channel, mut candidate: Channel) {
    choose_name(&mut target.name, candidate.name);
    choose_text(&mut target.logo, candidate.logo);
    choose_text(&mut target.country, candidate.country);
    choose_text(&mut target.format, candidate.format);
    choose_text(&mut target.network, candidate.network);
    choose_text(&mut target.website, candidate.website);
    merge_unique(&mut target.categories, candidate.categories);
    merge_unique(&mut target.languages, candidate.languages);
    merge_unique(&mut target.broadcast_area, candidate.broadcast_area);
    target.is_main |= candidate.is_main;
    for source in candidate.sources.drain(..) {
        add_source(target, source);
    }
}

fn normalize_and_group_channels(channels: Vec<Channel>) -> Vec<Channel> {
    let mut grouped: HashMap<String, Channel> = HashMap::new();
    for mut channel in channels {
        let (id, embedded_feed) = split_channel_feed(&channel.id);
        if id.is_empty() {
            continue;
        }
        channel.id = id;
        if channel.feed.is_none() {
            channel.feed = embedded_feed;
        }
        channel.key = logical_channel_key(&channel.id, channel.feed.as_deref());
        normalize_channel_sources(&mut channel);
        if channel.sources.is_empty() {
            continue;
        }
        if let Some(existing) = grouped.get_mut(&channel.key) {
            merge_channel(existing, channel);
        } else {
            grouped.insert(channel.key.clone(), channel);
        }
    }

    let mut channels: Vec<Channel> = grouped
        .into_values()
        .map(|mut channel| {
            sort_and_sync_sources(&mut channel);
            channel
        })
        .collect();
    channels.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.key.cmp(&right.key))
    });
    channels
}

fn amagi_identity_token(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    for start in 0..bytes.len().saturating_sub(4) {
        if bytes.get(start..start + 3) != Some(b"amg") {
            continue;
        }
        if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            continue;
        }

        let mut cursor = start + 3;
        let provider_digits = cursor;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor == provider_digits || bytes.get(cursor) != Some(&b'c') {
            continue;
        }

        cursor += 1;
        let channel_digits = cursor;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor == channel_digits
            || bytes
                .get(cursor)
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            continue;
        }

        return String::from_utf8(bytes[start..cursor].to_vec()).ok();
    }

    None
}

fn amagi_provider_channel_identity(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "amagi.tv" && !host.ends_with(".amagi.tv") {
        return None;
    }
    let host_identity = amagi_identity_token(&host)?;
    let path_identity = amagi_identity_token(parsed.path())?;
    (host_identity == path_identity).then_some(host_identity)
}

fn semantic_channel_title(value: &str) -> Option<String> {
    let mut words: Vec<String> = value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase())
        .collect();
    if words.first().is_some_and(|word| {
        (3..=5).contains(&word.len()) && word.chars().all(|character| character.is_ascii_digit())
    }) {
        words.remove(0);
    }
    (!words.is_empty()).then(|| words.join(" "))
}

fn amagi_fallback_title_matches(
    channel_name: &str,
    source_title: Option<&str>,
    fallback_title: Option<&str>,
) -> bool {
    let Some(fallback_title) = fallback_title.and_then(semantic_channel_title) else {
        return false;
    };
    source_title
        .and_then(semantic_channel_title)
        .is_some_and(|source_title| source_title == fallback_title)
        || semantic_channel_title(channel_name)
            .is_some_and(|channel_title| channel_title == fallback_title)
}

fn known_dead_amagi_replacement(url: &str) -> Option<&'static str> {
    let base_url = url.split(['?', '#']).next().unwrap_or(url);
    base_url
        .eq_ignore_ascii_case(ANI_ONE_DEAD_URL)
        .then_some(ANI_ONE_CURRENT_URL)
}

fn repair_known_dead_amagi_sources(channels: &mut [Channel]) -> usize {
    let mut repaired = 0;

    for channel in channels {
        let sources = std::mem::take(&mut channel.sources);
        for source in sources {
            let Some(replacement_url) = known_dead_amagi_replacement(&source.url) else {
                add_source(channel, source);
                continue;
            };

            let replacement = make_stream_source(
                source.title.clone(),
                replacement_url.into(),
                source.referrer.clone(),
                source.user_agent.clone(),
                source.quality.clone(),
                source.label.clone(),
            );
            if let Some(replacement) = replacement {
                add_source(channel, replacement);
                repaired += 1;
            } else {
                add_source(channel, source);
            }
        }
        sort_and_sync_sources(channel);
    }

    repaired
}

fn overlay_amagi_fast_fallbacks(channels: &mut [Channel], fallback_channels: &[Channel]) -> usize {
    let mut fallback_sources: HashMap<String, Vec<StreamSource>> = HashMap::new();
    for source in fallback_channels
        .iter()
        .flat_map(|channel| channel.sources.iter())
    {
        let Some(identity) = amagi_provider_channel_identity(&source.url) else {
            continue;
        };
        let candidates = fallback_sources.entry(identity).or_default();
        if let Some(existing) = candidates
            .iter_mut()
            .find(|candidate| candidate.id == source.id)
        {
            merge_source(existing, source.clone());
        } else {
            candidates.push(source.clone());
        }
    }
    for candidates in fallback_sources.values_mut() {
        candidates.sort_by(compare_sources);
    }

    let mut added = 0;
    for channel in channels {
        let mut channel_identities: HashMap<String, StreamSource> = HashMap::new();
        for source in &channel.sources {
            if let Some(identity) = amagi_provider_channel_identity(&source.url) {
                channel_identities
                    .entry(identity)
                    .or_insert_with(|| source.clone());
            }
        }
        let mut channel_identities: Vec<(String, StreamSource)> =
            channel_identities.into_iter().collect();
        channel_identities.sort_by(|left, right| left.0.cmp(&right.0));

        for (identity, template) in channel_identities {
            let Some(candidates) = fallback_sources.get(&identity) else {
                continue;
            };
            for candidate in candidates {
                if !amagi_fallback_title_matches(
                    &channel.name,
                    template.title.as_deref(),
                    candidate.title.as_deref(),
                ) {
                    continue;
                }
                let Some(candidate) = make_stream_source(
                    template.title.clone().or_else(|| candidate.title.clone()),
                    candidate.url.clone(),
                    candidate
                        .referrer
                        .clone()
                        .or_else(|| template.referrer.clone()),
                    candidate
                        .user_agent
                        .clone()
                        .or_else(|| template.user_agent.clone()),
                    candidate
                        .quality
                        .clone()
                        .or_else(|| template.quality.clone()),
                    candidate.label.clone().or_else(|| template.label.clone()),
                ) else {
                    continue;
                };
                if !channel
                    .sources
                    .iter()
                    .any(|source| source.id == candidate.id)
                {
                    added += 1;
                }
                add_source(channel, candidate);
            }
        }
        sort_and_sync_sources(channel);
    }

    added
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Could not start the network client: {error}"))
}

async fn fetch_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    name: &str,
) -> Result<T, String> {
    let response = client
        .get(format!("{API_BASE}/{name}.json"))
        .send()
        .await
        .map_err(|error| format!("Could not download {name}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The {name} service returned an error: {error}"))?;
    let label = format!("{name} catalogue data");
    let bytes = fetch_bounded_bytes(response, catalog_json_limit(name), &label).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Could not read {name}: {error}"))
}

fn catalog_json_limit(name: &str) -> usize {
    match name {
        "channels" | "feeds" | "logos" | "streams" => MAX_CATALOG_LARGE_JSON_BYTES,
        "guides" => MAX_CATALOG_GUIDES_JSON_BYTES,
        _ => MAX_CATALOG_METADATA_JSON_BYTES,
    }
}

async fn fetch_optional_fast_playlist(
    client: &reqwest::Client,
    source: &'static str,
) -> Vec<Channel> {
    let Ok(response) = client
        .get(source)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(mut response) = response.error_for_status() else {
        return Vec::new();
    };
    if response
        .content_length()
        .is_some_and(|length| length > MAX_OPTIONAL_FAST_PLAYLIST_BYTES as u64)
    {
        return Vec::new();
    }
    let mut content = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk))
                if content
                    .len()
                    .checked_add(chunk.len())
                    .is_some_and(|length| length <= MAX_OPTIONAL_FAST_PLAYLIST_BYTES) =>
            {
                content.extend_from_slice(&chunk);
            }
            Ok(Some(_)) | Err(_) => return Vec::new(),
            Ok(None) => break,
        }
    }
    let Ok(content) = String::from_utf8(content) else {
        return Vec::new();
    };
    parse_playlist(&content).unwrap_or_default()
}

async fn fetch_optional_fast_fallbacks(client: &reqwest::Client) -> Vec<Channel> {
    let mut tasks = tokio::task::JoinSet::new();
    for &source in OPTIONAL_FAST_PLAYLISTS {
        let client = client.clone();
        tasks.spawn(async move { fetch_optional_fast_playlist(&client, source).await });
    }

    let mut channels = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(mut playlist_channels) = result {
            channels.append(&mut playlist_channels);
        }
    }
    normalize_and_group_channels(channels)
}

async fn fetch_bounded_bytes(
    mut response: reqwest::Response,
    maximum_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(format!(
            "The {label} is larger than the {} limit.",
            format_byte_limit(maximum_bytes)
        ));
    }

    let mut content = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read {label}: {error}"))?
    {
        let next_length = content
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| format!("The {label} size overflowed."))?;
        if next_length > maximum_bytes {
            return Err(format!(
                "The {label} is larger than the {} limit.",
                format_byte_limit(maximum_bytes)
            ));
        }
        content.extend_from_slice(&chunk);
    }
    Ok(content)
}

fn format_byte_limit(bytes: usize) -> String {
    const MEBIBYTE: usize = 1024 * 1024;
    if bytes % MEBIBYTE == 0 {
        format!("{} MiB", bytes / MEBIBYTE)
    } else {
        format!("{bytes} bytes")
    }
}

async fn fetch_text(source: &str) -> Result<String, String> {
    let response = http_client()?
        .get(source)
        .send()
        .await
        .map_err(|error| format!("Could not download source: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The source returned an error: {error}"))?;
    String::from_utf8(fetch_bounded_bytes(response, MAX_PLAYLIST_BYTES, "playlist").await?)
        .map_err(|error| format!("The playlist is not valid UTF-8: {error}"))
}

fn cache_path_for(app: &tauri::AppHandle, file_name: &str) -> Option<PathBuf> {
    let directory = app.path().app_cache_dir().ok()?;
    fs::create_dir_all(&directory).ok()?;
    Some(directory.join(file_name))
}

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    cache_path_for(app, CATALOG_CACHE_FILE)
}

fn save_cache(app: &tauri::AppHandle, catalog: &Catalog) {
    if let (Some(path), Ok(content)) = (cache_path(app), serde_json::to_vec(catalog)) {
        let _ = fs::write(path, content);
    }
}

fn read_cache_file(app: &tauri::AppHandle, file_name: &str) -> Option<Catalog> {
    let content = fs::read(cache_path_for(app, file_name)?).ok()?;
    let mut catalog: Catalog = serde_json::from_slice(&content).ok()?;
    // Older caches contain one URL per Channel and no `sources` array. Normalize both old
    // and current cache shapes through the same grouping path before exposing them.
    catalog.channels = normalize_and_group_channels(catalog.channels);
    repair_known_dead_amagi_sources(&mut catalog.channels);
    (!catalog.channels.is_empty()).then_some(catalog)
}

fn read_cache(app: &tauri::AppHandle) -> Option<Catalog> {
    read_cache_file(app, CATALOG_CACHE_FILE)
}

fn read_legacy_cache(app: &tauri::AppHandle) -> Option<Catalog> {
    read_cache_file(app, LEGACY_CATALOG_CACHE_FILE)
}

fn normalized_channel_title(value: &str) -> Option<(String, String)> {
    let display = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let display = normalize_plain_text(Some(display), 256)?;
    let identity = display.to_lowercase();
    Some((display, identity))
}

fn channel_from_api_stream(
    stream: ApiStream,
    channel_map: &HashMap<String, ApiChannel>,
    excluded_channel_ids: &HashSet<String>,
    feed_map: &HashMap<(String, String), ApiFeed>,
    main_feed_map: &HashMap<String, ApiFeed>,
    channel_logos: &HashMap<String, String>,
    feed_logos: &HashMap<(String, String), String>,
    language_names: &HashMap<String, String>,
) -> Option<Channel> {
    let ApiStream {
        channel,
        feed: stream_feed,
        title,
        url,
        quality,
        label,
        user_agent,
        referrer,
    } = stream;

    let Some(channel_id) = channel else {
        let (display_name, normalized_title) = normalized_channel_title(&title)?;
        let id = format!("uncatalogued-{:016x}", stable_hash(&normalized_title));
        let source = make_stream_source(
            Some(display_name.clone()),
            url,
            referrer,
            user_agent,
            quality,
            label,
        )?;
        return Some(Channel {
            key: logical_channel_key(&id, None),
            id,
            feed: None,
            name: display_name,
            logo: None,
            categories: vec!["undefined".into()],
            country: None,
            languages: Vec::new(),
            broadcast_area: Vec::new(),
            sources: vec![source.clone()],
            url: source.url,
            referrer: source.referrer,
            user_agent: source.user_agent,
            quality: source.quality,
            label: source.label,
            format: None,
            network: None,
            website: None,
            is_main: true,
        });
    };

    // A channel ID can temporarily appear in streams.json before channels.json.
    // Keep that stream unless the channel is known and intentionally excluded.
    if excluded_channel_ids.contains(&channel_id) {
        return None;
    }
    let explicit_feed_id = normalize_plain_text(stream_feed, 128);
    let feed = if let Some(feed_id) = explicit_feed_id.as_ref() {
        feed_map.get(&(channel_id.clone(), feed_id.clone()))
    } else {
        main_feed_map.get(&channel_id)
    };
    // A stream's explicit feed is authoritative even when feeds.json is temporarily behind it.
    // Falling back to the main feed here would merge distinct regional streams.
    let feed_id = explicit_feed_id
        .clone()
        .or_else(|| feed.map(|item| item.id.clone()));
    let logo = feed_id
        .as_ref()
        .and_then(|id| feed_logos.get(&(channel_id.clone(), id.clone())).cloned())
        .or_else(|| channel_logos.get(&channel_id).cloned());
    let languages = feed
        .map(|item| {
            item.languages
                .iter()
                .map(|code| {
                    language_names
                        .get(code)
                        .cloned()
                        .unwrap_or_else(|| code.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let source = make_stream_source(
        Some(title.clone()),
        url,
        referrer,
        user_agent,
        quality,
        label,
    )?;
    let Some(api_channel) = channel_map.get(&channel_id) else {
        let (base_name, _) = normalized_channel_title(&title)?;
        let display_name = if let Some(feed) = feed {
            if feed.is_main || feed.name.eq_ignore_ascii_case(&base_name) {
                base_name
            } else {
                format!("{} — {}", base_name, feed.name)
            }
        } else if let Some(feed_id) = explicit_feed_id.as_deref() {
            format!("{base_name} — {feed_id}")
        } else {
            base_name
        };
        return Some(Channel {
            key: logical_channel_key(&channel_id, feed_id.as_deref()),
            id: channel_id.clone(),
            feed: feed_id,
            name: display_name,
            logo,
            categories: vec!["undefined".into()],
            country: country_from_id(&channel_id),
            languages,
            broadcast_area: feed
                .map(|item| item.broadcast_area.clone())
                .unwrap_or_default(),
            sources: vec![source.clone()],
            url: source.url,
            referrer: source.referrer,
            user_agent: source.user_agent,
            quality: source.quality,
            label: source.label,
            format: feed.and_then(|item| item.format.clone()),
            network: None,
            website: None,
            is_main: feed
                .map(|item| item.is_main)
                .unwrap_or(explicit_feed_id.is_none()),
        });
    };
    let display_name = if let Some(feed) = feed {
        if feed.is_main || feed.name.eq_ignore_ascii_case(&api_channel.name) {
            api_channel.name.clone()
        } else {
            format!("{} — {}", api_channel.name, feed.name)
        }
    } else if let Some(feed_id) = explicit_feed_id.as_deref() {
        format!("{} — {}", api_channel.name, feed_id)
    } else {
        api_channel.name.clone()
    };
    Some(Channel {
        key: logical_channel_key(&channel_id, feed_id.as_deref()),
        id: channel_id,
        feed: feed_id,
        name: display_name,
        logo,
        categories: if api_channel.categories.is_empty() {
            vec!["undefined".into()]
        } else {
            api_channel.categories.clone()
        },
        country: Some(api_channel.country.clone()),
        languages,
        broadcast_area: feed
            .map(|item| item.broadcast_area.clone())
            .unwrap_or_default(),
        sources: vec![source.clone()],
        url: source.url,
        referrer: source.referrer,
        user_agent: source.user_agent,
        quality: source.quality,
        label: source.label,
        format: feed.and_then(|item| item.format.clone()),
        network: api_channel.network.clone(),
        website: api_channel.website.clone(),
        is_main: feed
            .map(|item| item.is_main)
            .unwrap_or(explicit_feed_id.is_none()),
    })
}

fn coverage_option_counts(
    channels: &[Channel],
    api_regions: &[ApiRegion],
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut region_countries: HashMap<String, HashSet<String>> = HashMap::new();
    let mut country_regions: HashMap<String, HashSet<String>> = HashMap::new();
    for region in api_regions {
        let region_code = region.code.trim().to_ascii_uppercase();
        for country in &region.countries {
            let Some(country_code) = canonical_country_code(country) else {
                continue;
            };
            region_countries
                .entry(region_code.clone())
                .or_default()
                .insert(country_code.clone());
            country_regions
                .entry(country_code)
                .or_default()
                .insert(region_code.clone());
        }
    }

    let mut country_counts = HashMap::new();
    let mut region_counts = HashMap::new();
    for channel in channels {
        let mut channel_countries = HashSet::new();
        let mut channel_regions = HashSet::new();

        if channel.broadcast_area.is_empty() {
            if let Some(country) = channel.country.as_deref().and_then(canonical_country_code) {
                channel_countries.insert(country);
            }
        } else {
            for area in &channel.broadcast_area {
                let Some((kind, value)) = area.trim().split_once('/') else {
                    continue;
                };
                match kind.to_ascii_lowercase().as_str() {
                    "c" => {
                        if let Some(country) = canonical_country_code(value) {
                            channel_countries.insert(country);
                        }
                    }
                    "s" => {
                        if let Some(country) = value
                            .split_once('-')
                            .map(|(country, _)| country)
                            .and_then(canonical_country_code)
                        {
                            channel_countries.insert(country);
                        }
                    }
                    "ct" => {
                        if let Some(country) = value.get(..2).and_then(canonical_country_code) {
                            channel_countries.insert(country);
                        }
                    }
                    "r" => {
                        let region = value.trim().to_ascii_uppercase();
                        if let Some(countries) = region_countries.get(&region) {
                            channel_regions.insert(region);
                            channel_countries.extend(countries.iter().cloned());
                        }
                    }
                    _ => {}
                }
            }
        }

        for country in &channel_countries {
            if let Some(regions) = country_regions.get(country) {
                channel_regions.extend(regions.iter().cloned());
            }
        }
        for country in channel_countries {
            *country_counts.entry(country).or_default() += 1;
        }
        for region in channel_regions {
            *region_counts.entry(region).or_default() += 1;
        }
    }
    (country_counts, region_counts)
}

async fn build_catalog() -> Result<Catalog, String> {
    let client = http_client()?;
    let required_catalog = async {
        tokio::try_join!(
            fetch_json::<Vec<ApiChannel>>(&client, "channels"),
            fetch_json::<Vec<ApiFeed>>(&client, "feeds"),
            fetch_json::<Vec<ApiLogo>>(&client, "logos"),
            fetch_json::<Vec<ApiStream>>(&client, "streams"),
            fetch_json::<Vec<ApiCategory>>(&client, "categories"),
            fetch_json::<Vec<ApiLanguage>>(&client, "languages"),
            fetch_json::<Vec<ApiCountry>>(&client, "countries"),
            fetch_json::<Vec<ApiRegion>>(&client, "regions"),
            fetch_json::<Vec<ApiBlock>>(&client, "blocklist")
        )
    };
    let optional_fast_fallbacks =
        async { Ok::<_, String>(fetch_optional_fast_fallbacks(&client).await) };

    let (
        (
            api_channels,
            feeds,
            logos,
            streams,
            api_categories,
            api_languages,
            api_countries,
            api_regions,
            blocklist,
        ),
        optional_fast_fallbacks,
    ) = tokio::try_join!(required_catalog, optional_fast_fallbacks)?;

    let blocked: HashSet<String> = blocklist.into_iter().map(|item| item.channel).collect();
    let today = Utc::now().date_naive();
    let excluded_channel_ids: HashSet<String> = api_channels
        .iter()
        .filter(|channel| {
            blocked.contains(&channel.id) || channel_is_closed(channel.closed.as_deref(), today)
        })
        .map(|channel| channel.id.clone())
        .chain(blocked.iter().cloned())
        .collect();
    let channel_map: HashMap<String, ApiChannel> = api_channels
        .into_iter()
        .filter(|channel| {
            !blocked.contains(&channel.id) && !channel_is_closed(channel.closed.as_deref(), today)
        })
        .map(|channel| (channel.id.clone(), channel))
        .collect();

    let mut feed_map: HashMap<(String, String), ApiFeed> = HashMap::new();
    let mut main_feed_map: HashMap<String, ApiFeed> = HashMap::new();
    for feed in feeds {
        if feed.is_main {
            main_feed_map.insert(feed.channel.clone(), feed.clone());
        }
        feed_map.insert((feed.channel.clone(), feed.id.clone()), feed);
    }

    let mut channel_logos: HashMap<String, String> = HashMap::new();
    let mut feed_logos: HashMap<(String, String), String> = HashMap::new();
    for logo in logos {
        if !logo.in_use {
            continue;
        }
        if let Some(feed) = logo.feed {
            feed_logos.entry((logo.channel, feed)).or_insert(logo.url);
        } else {
            channel_logos.entry(logo.channel).or_insert(logo.url);
        }
    }

    let language_names: HashMap<String, String> = api_languages
        .iter()
        .map(|language| (language.code.clone(), language.name.clone()))
        .collect();

    let channels = streams
        .into_iter()
        .filter_map(|stream| {
            channel_from_api_stream(
                stream,
                &channel_map,
                &excluded_channel_ids,
                &feed_map,
                &main_feed_map,
                &channel_logos,
                &feed_logos,
                &language_names,
            )
        })
        .collect();

    let mut channels = normalize_and_group_channels(channels);
    let repaired_amagi_sources = repair_known_dead_amagi_sources(&mut channels);
    let added_fast_fallbacks =
        overlay_amagi_fast_fallbacks(&mut channels, &optional_fast_fallbacks);

    let mut category_counts: HashMap<String, usize> = HashMap::new();
    let mut language_counts: HashMap<String, usize> = HashMap::new();
    for channel in &channels {
        for category in &channel.categories {
            *category_counts.entry(category.clone()).or_default() += 1;
        }
        for language in &channel.languages {
            *language_counts.entry(language.clone()).or_default() += 1;
        }
    }
    let (country_counts, region_counts) = coverage_option_counts(&channels, &api_regions);

    let mut categories: Vec<NamedOption> = api_categories
        .into_iter()
        .map(|category| NamedOption {
            count: *category_counts.get(&category.id).unwrap_or(&0),
            id: category.id,
            name: category.name,
            description: Some(category.description),
        })
        .filter(|category| category.count > 0)
        .collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    let mut countries: Vec<CountryOption> = api_countries
        .into_iter()
        .map(|country| CountryOption {
            count: *country_counts.get(&country.code).unwrap_or(&0),
            code: country.code,
            name: country.name,
            flag: country.flag,
            languages: country.languages,
        })
        .filter(|country| country.count > 0)
        .collect();
    countries.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    let mut languages: Vec<NamedOption> = language_counts
        .into_iter()
        .map(|(name, count)| NamedOption {
            id: name.clone(),
            name,
            description: None,
            count,
        })
        .collect();
    languages.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    let mut regions: Vec<RegionOption> = api_regions
        .into_iter()
        .map(|region| RegionOption {
            count: *region_counts
                .get(&region.code.to_ascii_uppercase())
                .unwrap_or(&0),
            code: region.code,
            name: region.name,
            countries: region.countries,
        })
        .filter(|region| region.count > 0)
        .collect();
    regions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    Ok(Catalog {
        channels,
        categories,
        countries,
        languages,
        regions,
        updated_at: Utc::now().to_rfc3339(),
        source: if repaired_amagi_sources + added_fast_fallbacks > 0 {
            "IPTV-org API + current FAST fallbacks".into()
        } else {
            "IPTV-org API".into()
        },
    })
}

fn attribute_value(line: &str, key: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let marker = format!("{}=\"", key.to_ascii_lowercase());
    let start = lower.find(&marker)? + marker.len();
    let remainder = &line[start..];
    let value = remainder.split_once('"')?.0.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn first_attribute_value(line: &str, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| attribute_value(line, key))
}

fn canonical_country_code(value: &str) -> Option<String> {
    let code = value.trim().to_ascii_uppercase();
    if code.len() != 2
        || !code
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return None;
    }
    Some(if code == "GB" { "UK".into() } else { code })
}

fn country_from_id(id: &str) -> Option<String> {
    let base = id.split('@').next().unwrap_or(id);
    let suffix = base.rsplit('.').next()?;
    canonical_country_code(suffix)
}

#[derive(Debug)]
struct PendingPlaylistChannel {
    id: String,
    feed: Option<String>,
    name: String,
    logo: Option<String>,
    categories: Vec<String>,
    country: Option<String>,
    languages: Vec<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
    quality: Option<String>,
    label: Option<String>,
    format: Option<String>,
}

fn extinf_name(line: &str) -> String {
    let mut quoted = false;
    let mut separator = None;
    for (index, character) in line.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                separator = Some(index);
                break;
            }
            _ => {}
        }
    }
    separator
        .map(|index| line[index + 1..].trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Untitled channel".into())
}

fn playlist_categories(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(|category| category.trim().to_lowercase())
        .filter(|category| !category.is_empty())
        .collect()
}

fn strip_one_trailing_playlist_label(value: &str) -> Option<(String, String)> {
    let trimmed = value.trim();
    let without_closing = trimmed.trim_end_matches(']').trim_end();
    for label in ["Geo-blocked", "Not 24/7"] {
        if !without_closing
            .to_ascii_lowercase()
            .ends_with(&label.to_ascii_lowercase())
        {
            continue;
        }
        let prefix = without_closing[..without_closing.len() - label.len()].trim_end();
        if !prefix.ends_with('[') {
            continue;
        }
        let name = prefix.trim_end_matches('[').trim_end();
        return Some((name.to_string(), label.into()));
    }
    None
}

fn strip_trailing_playlist_labels(value: &str) -> (String, Vec<String>) {
    let mut name = value.trim().to_string();
    let mut labels = Vec::new();
    while let Some((remaining, label)) = strip_one_trailing_playlist_label(&name) {
        name = remaining;
        labels.push(label);
    }
    labels.reverse();
    (name, labels)
}

fn is_playlist_quality(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if matches!(lower.as_str(), "2k" | "4k" | "uhd" | "fhd" | "hd" | "sd") {
        return true;
    }
    let Some(digits) = lower.strip_suffix(['p', 'i']) else {
        return false;
    };
    !digits.is_empty()
        && digits.chars().all(|character| character.is_ascii_digit())
        && digits
            .parse::<u16>()
            .is_ok_and(|height| (100..=4_320).contains(&height))
}

fn strip_trailing_playlist_quality(value: &str) -> (String, Option<String>) {
    let trimmed = value.trim();
    let Some(prefix) = trimmed.strip_suffix(')') else {
        return (trimmed.to_string(), None);
    };
    let Some(opening) = prefix.rfind('(') else {
        return (trimmed.to_string(), None);
    };
    let quality = prefix[opening + 1..].trim();
    if !is_playlist_quality(quality) {
        return (trimmed.to_string(), None);
    }
    (
        prefix[..opening].trim_end().to_string(),
        Some(quality.to_string()),
    )
}

fn playlist_title_metadata(
    raw_name: &str,
    explicit_quality: Option<String>,
    explicit_label: Option<String>,
) -> (String, Option<String>, Option<String>) {
    let (without_label, trailing_labels) = strip_trailing_playlist_labels(raw_name);
    let (name, trailing_quality) = strip_trailing_playlist_quality(&without_label);
    let name = normalize_plain_text(Some(name), 256).unwrap_or_else(|| "Untitled channel".into());
    let trailing_label = (!trailing_labels.is_empty()).then(|| trailing_labels.join("; "));
    (
        name,
        explicit_quality.or(trailing_quality),
        explicit_label.or(trailing_label),
    )
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn split_url_metadata(line: &str) -> (String, Option<String>, Option<String>) {
    let Some((url, metadata)) = line.split_once('|') else {
        return (line.to_string(), None, None);
    };
    let mut referrer = None;
    let mut user_agent = None;
    let mut recognized = false;
    for field in metadata.split('&') {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        let key = percent_decode(key).trim().to_ascii_lowercase();
        let value = percent_decode(value);
        match key.as_str() {
            "user-agent" | "user_agent" | "http-user-agent" => {
                user_agent = Some(value);
                recognized = true;
            }
            "referer" | "referrer" | "http-referer" | "http-referrer" => {
                referrer = Some(value);
                recognized = true;
            }
            _ => {}
        }
    }
    if recognized {
        (url.trim().to_string(), referrer, user_agent)
    } else {
        (line.to_string(), None, None)
    }
}

fn apply_vlc_option(pending: &mut PendingPlaylistChannel, line: &str) {
    let lower = line.to_ascii_lowercase();
    let Some((_, value)) = line.split_once('=') else {
        return;
    };
    if lower.starts_with("#extvlcopt:http-user-agent=") {
        pending.user_agent = Some(value.trim().to_string());
    } else if lower.starts_with("#extvlcopt:http-referrer=")
        || lower.starts_with("#extvlcopt:http-referer=")
    {
        pending.referrer = Some(value.trim().to_string());
    }
}

fn parse_playlist(content: &str) -> Result<Vec<Channel>, String> {
    parse_playlist_with_limits(
        content,
        MAX_PLAYLIST_BYTES,
        MAX_PLAYLIST_ENTRIES,
        MAX_PLAYLIST_SOURCES_PER_CHANNEL,
    )
}

fn parse_playlist_with_limits(
    content: &str,
    maximum_bytes: usize,
    maximum_entries: usize,
    maximum_sources_per_channel: usize,
) -> Result<Vec<Channel>, String> {
    if content.len() > maximum_bytes {
        return Err(format!(
            "That playlist is larger than the {} MiB limit.",
            maximum_bytes / (1024 * 1024)
        ));
    }

    let mut channels = Vec::new();
    let mut entries_per_channel: HashMap<String, usize> = HashMap::new();
    let mut pending: Option<PendingPlaylistChannel> = None;
    for raw_line in content.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("#extinf") {
            let explicit_quality = first_attribute_value(line, &["quality", "tvg-quality"]);
            let explicit_label = attribute_value(line, "label");
            let (name, quality, label) =
                playlist_title_metadata(&extinf_name(line), explicit_quality, explicit_label);
            let raw_id = attribute_value(line, "tvg-id").unwrap_or_else(|| name.clone());
            let (id, feed) = split_channel_feed(&raw_id);
            let logo = attribute_value(line, "tvg-logo");
            let categories = attribute_value(line, "group-title")
                .map(|value| playlist_categories(&value))
                .unwrap_or_default();
            let country = first_attribute_value(line, &["tvg-country", "country"])
                .and_then(|value| value.split([';', ',']).find_map(canonical_country_code))
                .or_else(|| country_from_id(&id));
            let languages = attribute_value(line, "tvg-language")
                .map(|value| {
                    value
                        .split(';')
                        .map(|item| item.trim().to_string())
                        .collect()
                })
                .unwrap_or_default();
            pending = Some(PendingPlaylistChannel {
                id,
                feed,
                name,
                logo,
                categories,
                country,
                languages,
                referrer: first_attribute_value(
                    line,
                    &["http-referrer", "http-referer", "referrer", "referer"],
                ),
                user_agent: first_attribute_value(
                    line,
                    &["http-user-agent", "user-agent", "user_agent"],
                ),
                quality,
                label,
                format: first_attribute_value(line, &["tvg-format", "format"]),
            });
        } else if lower.starts_with("#extgrp:") {
            if let Some(pending) = pending.as_mut() {
                if pending.categories.is_empty() {
                    if let Some((_, value)) = line.split_once(':') {
                        pending.categories = playlist_categories(value);
                    }
                }
            }
        } else if lower.starts_with("#extvlcopt:") {
            if let Some(pending) = pending.as_mut() {
                apply_vlc_option(pending, line);
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some(pending) = pending.take() {
                let (url, pipe_referrer, pipe_user_agent) = split_url_metadata(line);
                let referrer = pipe_referrer.or(pending.referrer);
                let user_agent = pipe_user_agent.or(pending.user_agent);
                let Some(source) = make_stream_source(
                    Some(pending.name.clone()),
                    url,
                    referrer,
                    user_agent,
                    pending.quality,
                    pending.label,
                ) else {
                    continue;
                };
                if channels.len() >= maximum_entries {
                    return Err(format!(
                        "That playlist contains more than {maximum_entries} playable entries."
                    ));
                }
                let is_main = pending.feed.is_none();
                let key = logical_channel_key(&pending.id, pending.feed.as_deref());
                let entry_count = entries_per_channel.entry(key.clone()).or_default();
                if *entry_count >= maximum_sources_per_channel {
                    return Err(format!(
                        "One playlist channel contains more than {maximum_sources_per_channel} sources."
                    ));
                }
                *entry_count += 1;
                channels.push(Channel {
                    key,
                    id: pending.id,
                    feed: pending.feed,
                    name: pending.name,
                    logo: pending.logo,
                    categories: if pending.categories.is_empty() {
                        vec!["other".into()]
                    } else {
                        pending.categories
                    },
                    country: pending.country,
                    languages: pending.languages,
                    broadcast_area: Vec::new(),
                    sources: vec![source.clone()],
                    url: source.url,
                    referrer: source.referrer,
                    user_agent: source.user_agent,
                    quality: source.quality,
                    label: source.label,
                    format: pending.format,
                    network: None,
                    website: None,
                    is_main,
                });
            }
        }
    }
    let mut channels = normalize_and_group_channels(channels);
    repair_known_dead_amagi_sources(&mut channels);
    if channels.is_empty() {
        Err("No playable channels were found in that M3U playlist.".into())
    } else {
        Ok(channels)
    }
}

fn parse_xmltv_time(value: &str) -> Option<String> {
    let value = value.trim();
    if let Ok(parsed) = DateTime::parse_from_str(value, "%Y%m%d%H%M%S %z") {
        return Some(parsed.with_timezone(&Utc).to_rfc3339());
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y%m%d%H%M%S") {
        return Some(Utc.from_utc_datetime(&parsed).to_rfc3339());
    }
    None
}

fn channel_aliases(channel_ids: &[String]) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for original in channel_ids {
        aliases.insert(original.clone(), original.clone());
        let base = original.split('@').next().unwrap_or(original);
        aliases.insert(base.to_string(), original.clone());
        aliases.insert(base.to_lowercase(), original.clone());
    }
    aliases
}

fn parse_xmltv(content: &str, channel_ids: &[String]) -> Result<Vec<Programme>, String> {
    parse_xmltv_with_limits(
        content,
        channel_ids,
        MAX_XMLTV_BYTES,
        MAX_XMLTV_CHANNEL_IDS,
        MAX_XMLTV_PROGRAMMES,
    )
}

fn validate_xmltv_channel_ids(
    channel_ids: &[String],
    maximum_channel_ids: usize,
) -> Result<(), String> {
    if channel_ids.len() > maximum_channel_ids {
        return Err(format!(
            "That guide request contains more than {maximum_channel_ids} channel identifiers."
        ));
    }
    Ok(())
}

fn parse_xmltv_with_limits(
    content: &str,
    channel_ids: &[String],
    maximum_bytes: usize,
    maximum_channel_ids: usize,
    maximum_programmes: usize,
) -> Result<Vec<Programme>, String> {
    if content.len() > maximum_bytes {
        return Err(format!(
            "That programme guide is larger than the {} MiB limit.",
            maximum_bytes / (1024 * 1024)
        ));
    }
    validate_xmltv_channel_ids(channel_ids, maximum_channel_ids)?;

    let aliases = channel_aliases(channel_ids);
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);
    let mut programmes = Vec::new();
    let mut programme_count = 0_usize;
    let mut current: Option<Programme> = None;
    let mut text_target = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.name().as_ref() == b"programme" => {
                if programme_count >= maximum_programmes {
                    return Err(format!(
                        "That programme guide contains more than {maximum_programmes} programmes."
                    ));
                }
                programme_count += 1;
                let mut channel = None;
                let mut start = None;
                let mut stop = None;
                for attribute in event.attributes() {
                    let attribute = attribute.map_err(|error| {
                        format!("Could not parse XMLTV programme attributes: {error}")
                    })?;
                    let value = String::from_utf8_lossy(attribute.value.as_ref()).to_string();
                    match attribute.key.as_ref() {
                        b"channel" => channel = Some(value),
                        b"start" => start = parse_xmltv_time(&value),
                        b"stop" => stop = parse_xmltv_time(&value),
                        _ => {}
                    }
                }
                if let (Some(raw_channel), Some(start), Some(stop)) = (channel, start, stop) {
                    let matched = aliases
                        .get(&raw_channel)
                        .or_else(|| aliases.get(&raw_channel.to_lowercase()))
                        .cloned();
                    if let Some(channel_id) = matched {
                        current = Some(Programme {
                            channel_id,
                            title: "Live programme".into(),
                            description: None,
                            category: None,
                            start,
                            stop,
                        });
                    }
                }
            }
            Ok(Event::Start(event)) if current.is_some() => {
                text_target = match event.name().as_ref() {
                    b"title" => "title",
                    b"desc" => "desc",
                    b"category" => "category",
                    _ => "",
                }
                .to_string();
            }
            Ok(Event::Text(text)) if current.is_some() && !text_target.is_empty() => {
                let maximum_text_bytes = match text_target.as_str() {
                    "title" => MAX_XMLTV_TITLE_BYTES,
                    "desc" => MAX_XMLTV_DESCRIPTION_BYTES,
                    "category" => MAX_XMLTV_CATEGORY_BYTES,
                    _ => 0,
                };
                let raw_text: &[u8] = text.as_ref();
                if raw_text.len() > maximum_text_bytes {
                    text_target.clear();
                    continue;
                }
                let value = text
                    .decode()
                    .map(|value| value.into_owned())
                    .unwrap_or_default();
                if let Some(programme) = current.as_mut() {
                    match text_target.as_str() {
                        "title" if !value.is_empty() => programme.title = value,
                        "desc" if !value.is_empty() => programme.description = Some(value),
                        "category" if !value.is_empty() => programme.category = Some(value),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"programme" => {
                if let Some(programme) = current.take() {
                    programmes.push(programme);
                }
                text_target.clear();
            }
            Ok(Event::End(_)) => text_target.clear(),
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Could not parse XMLTV guide: {error}")),
            _ => {}
        }
    }
    programmes.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(programmes)
}

fn decode_xmltv_bytes_with_limits(
    source: &str,
    bytes: &[u8],
    maximum_gzip_bytes: usize,
    maximum_xml_bytes: usize,
) -> Result<String, String> {
    let is_gzip = source.to_ascii_lowercase().ends_with(".gz") || bytes.starts_with(&[0x1f, 0x8b]);
    let decoded = if is_gzip {
        if bytes.len() > maximum_gzip_bytes {
            return Err(format!(
                "The compressed programme guide is larger than the {} MiB limit.",
                maximum_gzip_bytes / (1024 * 1024)
            ));
        }
        let decoder = GzDecoder::new(bytes);
        let mut bounded = decoder.take(maximum_xml_bytes as u64 + 1);
        let mut decoded = Vec::new();
        bounded
            .read_to_end(&mut decoded)
            .map_err(|error| format!("Could not decompress programme guide: {error}"))?;
        if decoded.len() > maximum_xml_bytes {
            return Err(format!(
                "The decompressed programme guide is larger than the {} MiB limit.",
                maximum_xml_bytes / (1024 * 1024)
            ));
        }
        decoded
    } else {
        if bytes.len() > maximum_xml_bytes {
            return Err(format!(
                "The programme guide is larger than the {} MiB limit.",
                maximum_xml_bytes / (1024 * 1024)
            ));
        }
        bytes.to_vec()
    };

    String::from_utf8(decoded)
        .map_err(|error| format!("Programme guide is not valid UTF-8: {error}"))
}

async fn fetch_xmltv(source: &str) -> Result<String, String> {
    let response = http_client()?
        .get(source)
        .send()
        .await
        .map_err(|error| format!("Could not download programme guide: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The programme guide returned an error: {error}"))?;
    let bytes = fetch_bounded_bytes(response, MAX_XMLTV_TRANSFER_BYTES, "programme guide").await?;
    decode_xmltv_bytes_with_limits(source, &bytes, MAX_XMLTV_GZIP_BYTES, MAX_XMLTV_BYTES)
}

fn guide_result(programmes: Vec<Programme>, source: String) -> GuideResult {
    let matched_channels = programmes
        .iter()
        .map(|item| item.channel_id.clone())
        .collect::<HashSet<_>>()
        .len();
    GuideResult {
        programmes,
        source,
        matched_channels,
        updated_at: Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
async fn load_catalog(app: tauri::AppHandle, force: bool) -> Result<Catalog, String> {
    if !force {
        if let Some(cache) = read_cache(&app) {
            if DateTime::parse_from_rfc3339(&cache.updated_at)
                .ok()
                .map(|date| {
                    Utc::now()
                        .signed_duration_since(date.with_timezone(&Utc))
                        .num_hours()
                        < 12
                })
                .unwrap_or(false)
            {
                let cache_source = cache.source.clone();
                return Ok(Catalog {
                    source: format!("{cache_source} · local cache"),
                    ..cache
                });
            }
        }
    }
    match build_catalog().await {
        Ok(catalog) => {
            save_cache(&app, &catalog);
            Ok(catalog)
        }
        Err(error) => {
            if let Some(cache) = read_cache(&app).or_else(|| read_legacy_cache(&app)) {
                Ok(Catalog {
                    source: format!("Offline cache · {error}"),
                    ..cache
                })
            } else {
                let channels = parse_playlist(&fetch_text(DEFAULT_PLAYLIST).await?)?;
                Ok(Catalog {
                    channels,
                    categories: Vec::new(),
                    countries: Vec::new(),
                    languages: Vec::new(),
                    regions: Vec::new(),
                    updated_at: Utc::now().to_rfc3339(),
                    source: "IPTV-org fallback playlist".into(),
                })
            }
        }
    }
}

#[tauri::command]
async fn load_playlist(source: String) -> Result<Vec<Channel>, String> {
    let normalized = normalize_external_http_url(&source)?;
    parse_playlist(&fetch_text(&normalized).await?)
}

#[tauri::command]
fn parse_playlist_text(text: String) -> Result<Vec<Channel>, String> {
    parse_playlist(&text)
}

#[tauri::command]
async fn load_epg(source: String, channel_ids: Vec<String>) -> Result<GuideResult, String> {
    validate_xmltv_channel_ids(&channel_ids, MAX_XMLTV_CHANNEL_IDS)?;
    let normalized = normalize_external_http_url(&source)?;
    let programmes = parse_xmltv(&fetch_xmltv(&normalized).await?, &channel_ids)?;
    Ok(guide_result(programmes, normalized))
}

#[tauri::command]
async fn load_auto_epg(country: String, channel_ids: Vec<String>) -> Result<GuideResult, String> {
    validate_xmltv_channel_ids(&channel_ids, MAX_XMLTV_CHANNEL_IDS)?;
    let wanted: HashSet<&String> = channel_ids.iter().collect();
    if let Ok(guides) = fetch_json::<Vec<ApiGuide>>(&http_client()?, "guides").await {
        let mut source_coverage: HashMap<String, HashSet<String>> = HashMap::new();
        for guide in guides {
            let Some(channel) = guide.channel else {
                continue;
            };
            if !wanted.contains(&channel) {
                continue;
            }
            for source in guide.sources {
                source_coverage
                    .entry(source.url)
                    .or_default()
                    .insert(channel.clone());
            }
        }
        let mut ranked: Vec<(String, usize)> = source_coverage
            .into_iter()
            .map(|(url, channels)| (url, channels.len()))
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        for (source, _) in ranked.into_iter().take(8) {
            if let Ok(text) = fetch_xmltv(&source).await {
                if let Ok(programmes) = parse_xmltv(&text, &channel_ids) {
                    if !programmes.is_empty() {
                        return Ok(guide_result(programmes, format!("IPTV-org EPG · {source}")));
                    }
                }
            }
        }
    }

    let code = match country.trim().to_ascii_uppercase().as_str() {
        "GB" => "UK".into(),
        code => code.to_string(),
    };
    let filename = format!("epg_ripper_{code}1.xml.gz");
    for source in [
        format!("https://epgshare01.online/epgshare01/{filename}"),
        format!("https://raw.githubusercontent.com/epgshare01/share01/master/{filename}"),
    ] {
        if let Ok(text) = fetch_xmltv(&source).await {
            let programmes = parse_xmltv(&text, &channel_ids)?;
            if !programmes.is_empty() {
                return Ok(guide_result(
                    programmes,
                    format!("Automatic regional guide · {code}"),
                ));
            }
        }
    }
    Err(format!(
        "No current programme listings matched the {code} channels."
    ))
}

#[tauri::command]
fn parse_epg_text(text: String, channel_ids: Vec<String>) -> Result<GuideResult, String> {
    Ok(guide_result(
        parse_xmltv(&text, &channel_ids)?,
        "Imported XMLTV".into(),
    ))
}

fn normalize_external_http_url(raw: &str) -> Result<String, String> {
    const INVALID_URL: &str = "Only normal HTTP and HTTPS website addresses are supported.";

    if raw.is_empty()
        || raw.len() > MAX_EXTERNAL_URL_LENGTH
        || raw.trim() != raw
        || raw.chars().any(char::is_control)
    {
        return Err(INVALID_URL.into());
    }

    let parsed = reqwest::Url::parse(raw).map_err(|_| INVALID_URL.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(INVALID_URL.into());
    }

    Ok(parsed.to_string())
}

#[tauri::command]
fn open_web_destination(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let normalized = normalize_external_http_url(&url)?;
    app.opener()
        .open_url(normalized, None::<&str>)
        .map_err(|error| format!("CrowFlix could not open that website: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_catalog,
            load_playlist,
            parse_playlist_text,
            load_epg,
            load_auto_epg,
            parse_epg_text,
            open_web_destination
        ])
        .run(tauri::generate_context!())
        .expect("error while running CrowFlix");
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn gzip_bytes(content: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content).unwrap();
        encoder.finish().unwrap()
    }

    async fn response_from_raw_http(raw_response: Vec<u8>) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            stream.write_all(&raw_response).unwrap();
        });

        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/fixture"))
            .send()
            .await
            .unwrap();
        server.join().unwrap();
        response
    }

    fn fixture_channel(id: &str, feed: Option<&str>, source: StreamSource) -> Channel {
        Channel {
            key: logical_channel_key(id, feed),
            id: id.into(),
            feed: feed.map(str::to_string),
            name: "Crow TV".into(),
            logo: None,
            categories: vec!["entertainment".into()],
            country: Some("AU".into()),
            languages: vec!["English".into()],
            broadcast_area: vec!["c/AU".into()],
            sources: vec![source.clone()],
            url: source.url,
            referrer: source.referrer,
            user_agent: source.user_agent,
            quality: source.quality,
            label: source.label,
            format: Some("HD".into()),
            network: Some("Crow Network".into()),
            website: None,
            is_main: feed.is_none(),
        }
    }

    #[test]
    fn extracts_only_complete_amagi_provider_channel_identities() {
        assert_eq!(
            amagi_provider_channel_identity(ANI_ONE_DEAD_URL).as_deref(),
            Some("amg19223c9")
        );
        assert_eq!(
            amagi_provider_channel_identity(
                "https://AMG12345C67.playout.now3.amagi.tv/AMG12345C67/playlist.m3u8?tenant=amg12345"
            )
            .as_deref(),
            Some("amg12345c67")
        );
        for invalid in ["amg12345", "amg12345c", "xamg12345c67", "amg12345c67extra"] {
            assert_eq!(amagi_identity_token(invalid), None);
        }
        for invalid in [
            "https://playout.now3.amagi.tv/amg12345/playlist.m3u8",
            "https://playout.now3.amagi.tv/amg12345c/playlist.m3u8",
            "https://playout.now3.amagi.tv/xamg12345c67/playlist.m3u8",
            "https://playout.now3.amagi.tv/amg12345c67extra/playlist.m3u8",
            "https://amg12345c67.playout.now3.amagi.tv/amg12345c68/playlist.m3u8",
            "https://example.test/amg12345c67/playlist.m3u8",
            "https://example.test/live.m3u8",
        ] {
            assert_eq!(amagi_provider_channel_identity(invalid), None);
        }
    }

    #[test]
    fn amagi_fallback_titles_require_conservative_semantic_equivalence() {
        assert!(amagi_fallback_title_matches(
            "Ani-One — SD",
            Some("Ani-Blast"),
            Some("4065 Ani Blast")
        ));
        assert!(amagi_fallback_title_matches(
            "Crow News",
            None,
            Some("4100 Crow-News")
        ));
        assert!(!amagi_fallback_title_matches(
            "Come Dine with Me",
            Some("Come Dine with Me"),
            Some("Hell's Kitchen")
        ));
        assert!(!amagi_fallback_title_matches(
            "Antiques Road Trip",
            Some("Antiques Road Trip"),
            Some("PBS History")
        ));
        assert!(!amagi_fallback_title_matches(
            "Racer",
            Some("Racer"),
            Some("MavTV")
        ));
        assert!(!amagi_fallback_title_matches(
            "Untitled",
            Some("Untitled"),
            None
        ));
    }

    #[test]
    fn reused_amagi_identities_cannot_cross_wire_distinct_channels() {
        let collisions = [
            ("amg00654", "2", "Come Dine with Me", "Hell's Kitchen"),
            ("amg02333", "1", "Antiques Road Trip", "PBS History"),
            ("amg00378", "2", "Racer", "MavTV"),
        ];
        let mut channels = Vec::new();
        let mut fallback_channels = Vec::new();

        for (index, (provider, channel, base_title, fallback_title)) in
            collisions.into_iter().enumerate()
        {
            let base_url = format!(
                "https://{provider}-{provider}c{channel}-amgplt0001.playout.now3.amagi.tv/playlist/{provider}-{provider}c{channel}-amgplt0001/playlist.m3u8"
            );
            let fallback_url = format!(
                "https://{provider}-{provider}c{channel}-amgplt0099.playout.now3.amagi.tv/playlist/{provider}-{provider}c{channel}-amgplt0099/playlist.m3u8"
            );
            let base_source = make_stream_source(
                Some(base_title.into()),
                base_url.clone(),
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let fallback_source = make_stream_source(
                Some(fallback_title.into()),
                fallback_url,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            channels.push(fixture_channel(
                &format!("Collision{index}.au"),
                Some("AU"),
                base_source,
            ));
            fallback_channels.push(fixture_channel(
                &format!("FallbackCollision{index}.au"),
                None,
                fallback_source,
            ));
        }

        assert_eq!(
            overlay_amagi_fast_fallbacks(&mut channels, &fallback_channels),
            0
        );
        assert!(channels.iter().all(|channel| channel.sources.len() == 1));
    }

    #[test]
    fn replaces_the_verified_dead_ani_one_url_without_retaining_it() {
        let dead = make_stream_source(
            Some("Ani-Blast".into()),
            format!("{ANI_ONE_DEAD_URL}?stale=true"),
            None,
            None,
            Some("720p".into()),
            None,
        )
        .unwrap();
        let mut channels = vec![fixture_channel("AniOne.hk", Some("SD"), dead)];

        assert_eq!(repair_known_dead_amagi_sources(&mut channels), 1);
        assert_eq!(channels[0].sources.len(), 1);
        assert_eq!(channels[0].sources[0].url, ANI_ONE_CURRENT_URL);
        assert_eq!(channels[0].url, ANI_ONE_CURRENT_URL);
        assert!(!channels[0]
            .sources
            .iter()
            .any(|source| source.url.starts_with(ANI_ONE_DEAD_URL)));
        assert_eq!(channels[0].sources[0].quality.as_deref(), Some("720p"));
    }

    #[test]
    fn imported_playlists_cannot_reintroduce_the_dead_ani_one_url() {
        let channels = parse_playlist(&format!(
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"AniOne.hk@SD\",Ani-Blast\n{ANI_ONE_DEAD_URL}\n"
        ))
        .unwrap();

        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].sources.len(), 1);
        assert_eq!(channels[0].sources[0].url, ANI_ONE_CURRENT_URL);
        assert_eq!(channels[0].url, ANI_ONE_CURRENT_URL);
    }

    #[test]
    fn amagi_fallback_overlay_preserves_regional_urls_and_dedupes() {
        let regional_url = "https://amg11111-amg11111c22-amgplt0001.playout.now3.amagi.tv/playlist/amg11111-amg11111c22-amgplt0001/playlist.m3u8";
        let current_url = "https://amg11111-amg11111c22-amgplt0099.playout.now3.amagi.tv/playlist/amg11111-amg11111c22-amgplt0099/playlist.m3u8";
        let unrelated_url = "https://amg22222-amg22222c33-amgplt0099.playout.now3.amagi.tv/playlist/amg22222-amg22222c33-amgplt0099/playlist.m3u8";
        let regional = make_stream_source(
            Some("Regional".into()),
            regional_url.into(),
            Some("https://regional.example/watch".into()),
            Some("Regional Agent/1.0".into()),
            Some("720p".into()),
            Some("Geo-blocked".into()),
        )
        .unwrap();
        let unrelated = make_stream_source(
            Some("Unrelated".into()),
            "https://ordinary.example/live.m3u8".into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let current = make_stream_source(
            Some("4099 Regional".into()),
            current_url.into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let other_identity = make_stream_source(
            Some("Other identity".into()),
            unrelated_url.into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let mut channels = vec![
            fixture_channel("Regional.au", Some("AU"), regional),
            fixture_channel("Unrelated.au", Some("AU"), unrelated),
        ];
        let fallback_channels = vec![
            fixture_channel("FallbackOne.au", None, current.clone()),
            fixture_channel("FallbackDuplicate.au", None, current),
            fixture_channel("FallbackOther.au", None, other_identity),
        ];

        assert_eq!(
            overlay_amagi_fast_fallbacks(&mut channels, &fallback_channels),
            1
        );
        let regional = channels
            .iter()
            .find(|channel| channel.id == "Regional.au")
            .unwrap();
        assert_eq!(regional.sources.len(), 2);
        assert!(regional
            .sources
            .iter()
            .any(|source| source.url == regional_url));
        let overlaid = regional
            .sources
            .iter()
            .find(|source| source.url == current_url)
            .unwrap();
        assert_eq!(overlaid.title.as_deref(), Some("Regional"));
        assert_eq!(
            overlaid.referrer.as_deref(),
            Some("https://regional.example/watch")
        );
        assert_eq!(overlaid.user_agent.as_deref(), Some("Regional Agent/1.0"));
        assert_eq!(overlaid.quality.as_deref(), Some("720p"));
        assert_eq!(overlaid.label.as_deref(), Some("Geo-blocked"));
        let unrelated = channels
            .iter()
            .find(|channel| channel.id == "Unrelated.au")
            .unwrap();
        assert_eq!(unrelated.sources.len(), 1);
        assert_eq!(
            overlay_amagi_fast_fallbacks(&mut channels, &fallback_channels),
            0
        );
        assert_eq!(
            channels
                .iter()
                .find(|channel| channel.id == "Regional.au")
                .unwrap()
                .sources
                .len(),
            2
        );
    }

    #[test]
    fn exact_ani_one_repair_and_playlist_overlay_are_deterministic_together() {
        let dead = make_stream_source(
            Some("Ani-Blast".into()),
            ANI_ONE_DEAD_URL.into(),
            None,
            None,
            Some("720p".into()),
            None,
        )
        .unwrap();
        let fallback = parse_playlist(&format!(
            "#EXTM3U\n#EXTINF:-1,4065 Ani Blast\n{ANI_ONE_CURRENT_URL}\n"
        ))
        .unwrap();
        let mut channels = vec![fixture_channel("AniOne.hk", Some("SD"), dead)];

        assert_eq!(repair_known_dead_amagi_sources(&mut channels), 1);
        assert_eq!(overlay_amagi_fast_fallbacks(&mut channels, &fallback), 0);
        assert_eq!(channels[0].sources.len(), 1);
        assert_eq!(channels[0].sources[0].url, ANI_ONE_CURRENT_URL);
    }

    #[test]
    fn parses_custom_m3u_metadata() {
        let text = r#"#EXTM3U
#EXTINF:-1 tvg-id="CrowTV.au" tvg-logo="https://example.test/crow.png" tvg-language="English" group-title="Movies;Entertainment",Crow TV
https://example.test/live.m3u8"#;
        let channels = parse_playlist(text).expect("playlist should parse");
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "Crow TV");
        assert_eq!(channels[0].country.as_deref(), Some("AU"));
        assert_eq!(channels[0].categories, vec!["movies", "entertainment"]);
        assert_eq!(channels[0].sources.len(), 1);
        assert_eq!(channels[0].key, "CrowTV.au@main");
    }

    #[test]
    fn parses_and_prioritizes_playlist_request_headers() {
        let text = r#"#EXTM3U
#EXTINF:-1 tvg-id="CrowTV.au@HD" http-user-agent="Attribute Agent" http-referrer="https://attribute.example/" quality="1080p" group-title="Entertainment",Crow TV, International
#EXTVLCOPT:http-user-agent=VLC Agent
#EXTVLCOPT:http-referrer=https://vlc.example/watch
https://video.example/live.m3u8|User-Agent=Pipe+Agent%2F1.0&Referer=https%3A%2F%2Fpipe.example%2Fwatch
#EXTINF:-1 tvg-id="CrowTV.au@HD" http-user-agent="Attribute Agent" http-referrer="https://attribute.example/" group-title="Entertainment",Crow TV
https://backup.example/live.mpd
#EXTINF:-1 tvg-id="CrowTV.au@HD" group-title="Entertainment",Unsupported Crow TV
rtmp://unsupported.example/live
"#;
        let channels = parse_playlist(text).expect("playlist should parse");
        assert_eq!(channels.len(), 1);
        let channel = &channels[0];
        assert_eq!(channel.id, "CrowTV.au");
        assert_eq!(channel.feed.as_deref(), Some("HD"));
        assert_eq!(channel.key, "CrowTV.au@HD");
        assert_eq!(channel.sources.len(), 2);
        assert_eq!(channel.sources[0].transport, StreamTransport::Hls);
        assert_eq!(
            channel.sources[0].user_agent.as_deref(),
            Some("Pipe Agent/1.0")
        );
        assert_eq!(
            channel.sources[0].referrer.as_deref(),
            Some("https://pipe.example/watch")
        );
        assert_eq!(channel.sources[1].transport, StreamTransport::Dash);
        assert_eq!(
            channel.sources[1].user_agent.as_deref(),
            Some("Attribute Agent")
        );
    }

    #[test]
    fn source_ids_grouping_and_ordering_are_deterministic() {
        let stable = make_stream_source(
            Some("Stable".into()),
            "https://stable.example/live.m3u8".into(),
            None,
            None,
            Some("720p".into()),
            None,
        )
        .unwrap();
        let intermittent = make_stream_source(
            Some("Intermittent".into()),
            "https://intermittent.example/live.m3u8".into(),
            None,
            None,
            Some("1080p".into()),
            Some("Not 24/7".into()),
        )
        .unwrap();
        let geo_blocked = make_stream_source(
            Some("Geo".into()),
            "https://geo.example/live.m3u8".into(),
            None,
            None,
            Some("2160p".into()),
            Some("Geo-blocked".into()),
        )
        .unwrap();
        let repeated = make_stream_source(
            Some("Stable renamed".into()),
            "https://stable.example/live.m3u8".into(),
            None,
            None,
            Some("720p".into()),
            None,
        )
        .unwrap();
        assert_eq!(stable.id, repeated.id);

        let forward = normalize_and_group_channels(vec![
            fixture_channel("CrowTV.au", Some("HD"), geo_blocked.clone()),
            fixture_channel("CrowTV.au", Some("HD"), stable.clone()),
            fixture_channel("CrowTV.au", Some("HD"), intermittent.clone()),
            fixture_channel("CrowTV.au", Some("HD"), repeated),
        ]);
        let reverse = normalize_and_group_channels(vec![
            fixture_channel("CrowTV.au", Some("HD"), intermittent),
            fixture_channel("CrowTV.au", Some("HD"), stable),
            fixture_channel("CrowTV.au", Some("HD"), geo_blocked),
        ]);

        assert_eq!(forward.len(), 1);
        assert_eq!(forward[0].key, "CrowTV.au@HD");
        assert_eq!(forward[0].sources.len(), 3);
        assert_eq!(forward[0].sources[0].title.as_deref(), Some("Stable"));
        assert_eq!(forward[0].sources[1].label.as_deref(), Some("Not 24/7"));
        assert_eq!(forward[0].sources[2].label.as_deref(), Some("Geo-blocked"));
        assert_eq!(
            forward[0]
                .sources
                .iter()
                .map(|source| &source.id)
                .collect::<Vec<_>>(),
            reverse[0]
                .sources
                .iter()
                .map(|source| &source.id)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn retains_and_groups_uncatalogued_api_streams_by_normalized_title() {
        let streams = vec![
            ApiStream {
                channel: None,
                feed: None,
                title: "  Mystery   Channel ".into(),
                url: "https://one.example/live.m3u8".into(),
                quality: Some("720p".into()),
                label: None,
                user_agent: None,
                referrer: None,
            },
            ApiStream {
                channel: None,
                feed: None,
                title: "mystery channel".into(),
                url: "https://two.example/live.m3u8".into(),
                quality: Some("1080p".into()),
                label: None,
                user_agent: None,
                referrer: None,
            },
        ];
        let channels = streams
            .into_iter()
            .filter_map(|stream| {
                channel_from_api_stream(
                    stream,
                    &HashMap::new(),
                    &HashSet::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                )
            })
            .collect();
        let grouped = normalize_and_group_channels(channels);

        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].name, "Mystery Channel");
        assert_eq!(
            grouped[0].id,
            format!("uncatalogued-{:016x}", stable_hash("mystery channel"))
        );
        assert_eq!(grouped[0].categories, vec!["undefined"]);
        assert_eq!(grouped[0].country, None);
        assert!(grouped[0].broadcast_area.is_empty());
        assert_eq!(grouped[0].sources.len(), 2);
    }

    #[test]
    fn retains_pending_channel_ids_without_reintroducing_excluded_channels() {
        let stream = || ApiStream {
            channel: Some("PendingChannel.ru".into()),
            feed: Some("RU".into()),
            title: "Pending Channel".into(),
            url: "https://pending.example/live.m3u8".into(),
            quality: Some("1080p".into()),
            label: None,
            user_agent: None,
            referrer: None,
        };
        let retained = channel_from_api_stream(
            stream(),
            &HashMap::new(),
            &HashSet::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("a stream ahead of channels.json should remain available");

        assert_eq!(retained.id, "PendingChannel.ru");
        assert_eq!(retained.feed.as_deref(), Some("RU"));
        assert_eq!(retained.key, "PendingChannel.ru@RU");
        assert_eq!(retained.name, "Pending Channel — RU");
        assert_eq!(retained.country.as_deref(), Some("RU"));
        assert_eq!(retained.categories, vec!["undefined"]);

        let excluded = HashSet::from(["PendingChannel.ru".to_string()]);
        assert!(channel_from_api_stream(
            stream(),
            &HashMap::new(),
            &excluded,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .is_none());
    }

    #[test]
    fn preserves_explicit_api_feed_when_feed_metadata_is_missing() {
        let channel_id = "CrowTV.au".to_string();
        let mut channel_map = HashMap::new();
        channel_map.insert(
            channel_id.clone(),
            ApiChannel {
                id: channel_id.clone(),
                name: "Crow TV".into(),
                network: None,
                country: "AU".into(),
                categories: vec!["entertainment".into()],
                closed: None,
                website: None,
            },
        );
        let main_feed = ApiFeed {
            channel: channel_id.clone(),
            id: "SD".into(),
            name: "Crow TV".into(),
            is_main: true,
            broadcast_area: vec!["c/AU".into()],
            languages: vec!["eng".into()],
            format: Some("SD".into()),
        };
        let mut feed_map = HashMap::new();
        feed_map.insert(
            (channel_id.clone(), main_feed.id.clone()),
            main_feed.clone(),
        );
        let mut main_feed_map = HashMap::new();
        main_feed_map.insert(channel_id.clone(), main_feed);

        let channel = channel_from_api_stream(
            ApiStream {
                channel: Some(channel_id),
                feed: Some("RO".into()),
                title: "Crow TV".into(),
                url: "https://video.example/live.m3u8".into(),
                quality: None,
                label: None,
                user_agent: None,
                referrer: None,
            },
            &channel_map,
            &HashSet::new(),
            &feed_map,
            &main_feed_map,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("stream should remain catalogued");

        assert_eq!(channel.feed.as_deref(), Some("RO"));
        assert_eq!(channel.key, "CrowTV.au@RO");
        assert_eq!(channel.name, "Crow TV — RO");
        assert!(!channel.is_main);
        assert!(channel.broadcast_area.is_empty());
        assert!(channel.languages.is_empty());
        assert_eq!(channel.format, None);
    }

    #[test]
    fn parses_current_iptv_org_title_annotations_and_malformed_brackets() {
        let text = r#"#EXTM3U
#EXTINF:-1 tvg-id="PartTime.uk@SD" group-title="Music",4 Fun TV (576i) [[Not 24/7]]
https://part.example/live.m3u8
#EXTINF:-1 tvg-id="Geo.au@Sydney" group-title="Entertainment",9Gem (720p) [Geo-blocked]
https://geo.example/live.m3u8
#EXTINF:-1 tvg-id="Both.nz@SD" group-title="News",Crow News (1080p) [[Not 24/7]] [Geo-blocked]
https://both.example/live.m3u8
"#;
        let channels = parse_playlist(text).expect("playlist should parse");
        assert_eq!(channels.len(), 3);

        let part_time = channels
            .iter()
            .find(|channel| channel.id == "PartTime.uk")
            .unwrap();
        assert_eq!(part_time.name, "4 Fun TV");
        assert_eq!(part_time.country.as_deref(), Some("UK"));
        assert_eq!(part_time.quality.as_deref(), Some("576i"));
        assert_eq!(part_time.label.as_deref(), Some("Not 24/7"));

        let geo = channels
            .iter()
            .find(|channel| channel.id == "Geo.au")
            .unwrap();
        assert_eq!(geo.name, "9Gem");
        assert_eq!(geo.quality.as_deref(), Some("720p"));
        assert_eq!(geo.label.as_deref(), Some("Geo-blocked"));

        let both = channels
            .iter()
            .find(|channel| channel.id == "Both.nz")
            .unwrap();
        assert_eq!(both.name, "Crow News");
        assert_eq!(both.quality.as_deref(), Some("1080p"));
        assert_eq!(both.label.as_deref(), Some("Not 24/7; Geo-blocked"));
        assert_eq!(
            source_availability(both.label.as_deref()),
            SourceAvailability::GeoBlocked
        );
    }

    #[test]
    fn explicit_playlist_metadata_country_and_extgrp_take_precedence() {
        let text = r#"#EXTM3U
#EXTINF:-1 tvg-id="CrowTV.us@SD" tvg-country="gb" quality="1080p" label="Non geo blocked",Crow TV (720p) [Geo-blocked]
#EXTGRP:News;Public
https://video.example/live.m3u8
#EXTINF:-1 tvg-id="Alias.zz@SD" country="au" group-title="General",Country Alias
https://alias.example/live.m3u8
"#;
        let channels = parse_playlist(text).expect("playlist should parse");
        assert_eq!(channels.len(), 2);
        let channel = channels
            .iter()
            .find(|channel| channel.id == "CrowTV.us")
            .unwrap();
        assert_eq!(channel.name, "Crow TV");
        assert_eq!(channel.country.as_deref(), Some("UK"));
        assert_eq!(channel.categories, vec!["news", "public"]);
        assert_eq!(channel.quality.as_deref(), Some("1080p"));
        assert_eq!(channel.label.as_deref(), Some("Non geo blocked"));
        assert_eq!(
            source_availability(channel.label.as_deref()),
            SourceAvailability::Normal
        );
        assert_eq!(
            channels
                .iter()
                .find(|channel| channel.id == "Alias.zz")
                .unwrap()
                .country
                .as_deref(),
            Some("AU")
        );
        assert_eq!(country_from_id("BBC.uk@London").as_deref(), Some("UK"));
        assert_eq!(country_from_id("BBC.gb").as_deref(), Some("UK"));
    }

    #[test]
    fn availability_tiers_dominate_transport_and_quality() {
        let normal = make_stream_source(
            None,
            "http://normal.example/live.mpd".into(),
            None,
            None,
            Some("240p".into()),
            None,
        )
        .unwrap();
        let non_geo = make_stream_source(
            None,
            "http://non-geo.example/live.mpd".into(),
            None,
            None,
            Some("240p".into()),
            Some("Non geo blocked".into()),
        )
        .unwrap();
        let part_time = make_stream_source(
            None,
            "https://part.example/live.m3u8".into(),
            None,
            None,
            Some("2160p".into()),
            Some("Not 24/7".into()),
        )
        .unwrap();
        let geo = make_stream_source(
            None,
            "https://geo.example/live.m3u8".into(),
            None,
            None,
            Some("2160p".into()),
            Some("Geo-blocked".into()),
        )
        .unwrap();

        assert_eq!(
            source_availability(non_geo.label.as_deref()),
            SourceAvailability::Normal
        );
        assert!(normal.preference_score > part_time.preference_score);
        assert!(non_geo.preference_score > part_time.preference_score);
        assert!(part_time.preference_score > geo.preference_score);
    }

    #[test]
    fn coverage_counts_broadcast_areas_once_with_origin_fallback() {
        let regions = vec![
            ApiRegion {
                code: "APAC".into(),
                name: "Asia-Pacific".into(),
                countries: vec!["AU".into(), "NZ".into()],
            },
            ApiRegion {
                code: "AMER".into(),
                name: "Americas".into(),
                countries: vec!["US".into(), "CA".into()],
            },
        ];
        let source =
            |url: &str| make_stream_source(None, url.into(), None, None, None, None).unwrap();
        let mut australia =
            fixture_channel("Australia.au", None, source("https://a.example/live.m3u8"));
        australia.broadcast_area = vec!["c/AU".into(), "s/AU-NSW".into(), "ct/AUSYD".into()];
        let mut americas =
            fixture_channel("Americas.us", None, source("https://b.example/live.m3u8"));
        americas.broadcast_area = vec!["r/AMER".into()];
        let mut new_zealand =
            fixture_channel("NewZealand.nz", None, source("https://c.example/live.m3u8"));
        new_zealand.country = Some("NZ".into());
        new_zealand.broadcast_area.clear();
        let mut us_broadcast =
            fixture_channel("USFeed.au", None, source("https://d.example/live.m3u8"));
        us_broadcast.country = Some("AU".into());
        us_broadcast.broadcast_area = vec!["c/US".into()];

        let (countries, region_counts) =
            coverage_option_counts(&[australia, americas, new_zealand, us_broadcast], &regions);
        assert_eq!(countries.get("AU"), Some(&1));
        assert_eq!(countries.get("NZ"), Some(&1));
        assert_eq!(countries.get("US"), Some(&2));
        assert_eq!(countries.get("CA"), Some(&1));
        assert_eq!(region_counts.get("APAC"), Some(&2));
        assert_eq!(region_counts.get("AMER"), Some(&2));
    }

    #[test]
    fn normalizes_malformed_headers_without_exposing_them() {
        let source = make_stream_source(
            None,
            "https://video.example/live.m3u8".into(),
            Some("javascript:alert(1)".into()),
            Some("#EXTVLCOPT:http-user-agent=Safe Agent/1.0".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(source.user_agent.as_deref(), Some("Safe Agent/1.0"));
        assert_eq!(source.referrer, None);

        let injected = make_stream_source(
            None,
            "https://video.example/other.m3u8".into(),
            None,
            Some("Agent\r\nInjected: value".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(injected.user_agent, None);
    }

    #[test]
    fn migrates_legacy_single_url_channel_shape() {
        let legacy = r#"{
          "key":"CrowTV.au@main#42","id":"CrowTV.au","feed":null,"name":"Crow TV",
          "logo":null,"categories":["entertainment"],"country":"AU","languages":["English"],
          "broadcastArea":["c/AU"],"url":"https://legacy.example/live.m3u8",
          "referrer":"https://legacy.example/watch","userAgent":"Legacy Agent",
          "quality":"720p","label":null,"format":"HD","network":null,"website":null,"isMain":true
        }"#;
        let channel: Channel =
            serde_json::from_str(legacy).expect("legacy channel should deserialize");
        assert!(channel.sources.is_empty());
        let migrated = normalize_and_group_channels(vec![channel]);
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].key, "CrowTV.au@main");
        assert_eq!(migrated[0].sources.len(), 1);
        assert_eq!(
            migrated[0].sources[0].user_agent.as_deref(),
            Some("Legacy Agent")
        );
    }

    #[test]
    fn excludes_only_valid_closed_dates_at_or_before_today() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
        assert!(channel_is_closed(Some("2026-07-29"), today));
        assert!(channel_is_closed(Some("2026-07-30"), today));
        assert!(!channel_is_closed(Some("2026-07-31"), today));
        assert!(!channel_is_closed(Some("not-a-date"), today));
        assert!(!channel_is_closed(None, today));
    }

    #[test]
    fn accepts_only_normal_external_http_urls() {
        assert_eq!(
            normalize_external_http_url("https://example.com/watch?q=one#now").unwrap(),
            "https://example.com/watch?q=one#now"
        );
        assert_eq!(
            normalize_external_http_url("http://example.com:8080/live").unwrap(),
            "http://example.com:8080/live"
        );

        for rejected in [
            "",
            " https://example.com",
            "https://example.com\n",
            "//example.com/watch",
            "javascript:alert(1)",
            "data:text/html,test",
            "file:///C:/Windows",
            "ftp://example.com/file",
            "mailto:test@example.com",
            "https://user:password@example.com/",
        ] {
            assert!(
                normalize_external_http_url(rejected).is_err(),
                "expected {rejected:?} to be rejected"
            );
        }
    }

    #[tokio::test]
    async fn custom_imports_reject_non_http_sources_before_fetching() {
        let playlist_error = load_playlist("file:///C:/private/list.m3u".into())
            .await
            .unwrap_err();
        let guide_error = load_epg("data:text/xml,<tv/>".into(), Vec::new())
            .await
            .unwrap_err();

        assert!(playlist_error.contains("Only normal HTTP and HTTPS"));
        assert!(guide_error.contains("Only normal HTTP and HTTPS"));
    }

    #[tokio::test]
    async fn auto_epg_rejects_excess_channel_ids_before_network_access() {
        let error = load_auto_epg("AU".into(), vec![String::new(); MAX_XMLTV_CHANNEL_IDS + 1])
            .await
            .unwrap_err();
        assert!(error.contains("channel identifiers"));
    }

    #[tokio::test]
    async fn bounded_fetch_rejects_oversized_declared_content_length() {
        let response = response_from_raw_http(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n12345".to_vec(),
        )
        .await;

        let error = fetch_bounded_bytes(response, 4, "test response")
            .await
            .unwrap_err();
        assert!(error.contains("larger than the 4 bytes limit"));
    }

    #[tokio::test]
    async fn bounded_fetch_rejects_oversized_chunked_body_without_length() {
        let response = response_from_raw_http(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n".to_vec(),
        )
        .await;
        assert_eq!(response.content_length(), None);

        let error = fetch_bounded_bytes(response, 4, "test response")
            .await
            .unwrap_err();
        assert!(error.contains("larger than the 4 bytes limit"));
    }

    #[test]
    fn catalogue_json_limits_are_endpoint_aware() {
        assert_eq!(catalog_json_limit("channels"), MAX_CATALOG_LARGE_JSON_BYTES);
        assert_eq!(catalog_json_limit("streams"), MAX_CATALOG_LARGE_JSON_BYTES);
        assert_eq!(
            catalog_json_limit("categories"),
            MAX_CATALOG_METADATA_JSON_BYTES
        );
        assert_eq!(catalog_json_limit("guides"), MAX_CATALOG_GUIDES_JSON_BYTES);
    }

    #[test]
    fn enforces_playlist_byte_entry_and_per_channel_source_limits() {
        let one = "#EXTM3U\n#EXTINF:-1 tvg-id=\"One.au\",One\nhttps://one.example/live.m3u8\n";
        assert_eq!(
            parse_playlist_with_limits(one, one.len(), 1, 1)
                .unwrap()
                .len(),
            1
        );
        assert!(parse_playlist_with_limits(one, one.len() - 1, 1, 1).is_err());

        let two_channels =
            format!("{one}#EXTINF:-1 tvg-id=\"Two.au\",Two\nhttps://two.example/live.m3u8\n");
        assert!(parse_playlist_with_limits(&two_channels, two_channels.len(), 1, 1).is_err());

        let two_sources = format!(
            "{one}#EXTINF:-1 tvg-id=\"One.au\",One backup\nhttps://backup.example/live.m3u8\n"
        );
        assert!(parse_playlist_with_limits(&two_sources, two_sources.len(), 2, 1).is_err());
    }

    #[test]
    fn enforces_xmltv_byte_identifier_programme_and_field_limits() {
        let one = r#"<tv><programme start="20260715070000 +1000" stop="20260715080000 +1000" channel="One.au"><title>One</title></programme></tv>"#;
        let ids = vec!["One.au".to_string()];
        assert_eq!(
            parse_xmltv_with_limits(one, &ids, one.len(), 1, 1)
                .unwrap()
                .len(),
            1
        );
        assert!(parse_xmltv_with_limits(one, &ids, one.len() - 1, 1, 1).is_err());

        let excess_ids = vec!["One.au".to_string(), "Two.au".to_string()];
        assert!(parse_xmltv_with_limits(one, &excess_ids, one.len(), 1, 1).is_err());

        let two_programmes = r#"<tv>
          <programme start="20260715070000 +1000" stop="20260715080000 +1000" channel="One.au"><title>One</title></programme>
          <programme start="20260715080000 +1000" stop="20260715090000 +1000" channel="One.au"><title>Two</title></programme>
        </tv>"#;
        assert!(parse_xmltv_with_limits(two_programmes, &ids, two_programmes.len(), 1, 1).is_err());

        let oversized_title = format!(
            r#"<tv><programme start="20260715070000 +1000" stop="20260715080000 +1000" channel="One.au"><title>{}</title></programme></tv>"#,
            "x".repeat(MAX_XMLTV_TITLE_BYTES + 1)
        );
        let programmes =
            parse_xmltv_with_limits(&oversized_title, &ids, oversized_title.len(), 1, 1).unwrap();
        assert_eq!(programmes[0].title, "Live programme");
    }

    #[test]
    fn rejects_malformed_xmltv_attributes_instead_of_silently_skipping_them() {
        let malformed = r#"<tv><programme channel="One.au" channel="Two.au" start="20260715070000 +1000" stop="20260715080000 +1000"><title>One</title></programme></tv>"#;
        let error =
            parse_xmltv_with_limits(malformed, &["One.au".to_string()], malformed.len(), 1, 1)
                .unwrap_err();
        assert!(error.contains("programme attributes"));
    }

    #[test]
    fn enforces_compressed_and_decompressed_xmltv_limits() {
        let xml = b"<tv><channel id=\"One.au\"/></tv>";
        let gzip = gzip_bytes(xml);

        assert_eq!(
            decode_xmltv_bytes_with_limits("guide.xml.gz", &gzip, gzip.len(), xml.len()).unwrap(),
            String::from_utf8(xml.to_vec()).unwrap()
        );
        assert!(
            decode_xmltv_bytes_with_limits("guide.xml.gz", &gzip, gzip.len() - 1, xml.len())
                .is_err()
        );
        assert!(
            decode_xmltv_bytes_with_limits("guide.xml.gz", &gzip, gzip.len(), xml.len() - 1)
                .is_err()
        );
        assert_eq!(
            decode_xmltv_bytes_with_limits("guide.xml", xml, gzip.len(), xml.len()).unwrap(),
            String::from_utf8(xml.to_vec()).unwrap()
        );
        assert!(
            decode_xmltv_bytes_with_limits("guide.xml", xml, gzip.len(), xml.len() - 1).is_err()
        );
    }

    #[test]
    fn rejects_invalid_utf8_in_plain_and_gzipped_xmltv() {
        let invalid = [0xff, 0xfe];
        assert!(decode_xmltv_bytes_with_limits("guide.xml", &invalid, 16, 16).is_err());

        let gzip = gzip_bytes(&invalid);
        let error =
            decode_xmltv_bytes_with_limits("guide.xml.gz", &gzip, gzip.len(), 16).unwrap_err();
        assert!(error.contains("not valid UTF-8"));
    }

    #[test]
    fn parses_live_xmltv_window() {
        let text = r#"<tv><programme start="20260715070000 +1000" stop="20260715080000 +1000" channel="CrowTV.au"><title>Crow at Seven</title><desc>Live details.</desc><category>News</category></programme></tv>"#;
        let programmes = parse_xmltv(text, &["CrowTV.au".into()]).expect("guide should parse");
        assert_eq!(programmes.len(), 1);
        assert_eq!(programmes[0].title, "Crow at Seven");
        assert_eq!(programmes[0].category.as_deref(), Some("News"));
    }

    #[tokio::test]
    #[ignore = "requires the live IPTV-org network services"]
    async fn builds_authoritative_iptv_org_catalog() {
        let catalog = build_catalog()
            .await
            .expect("IPTV-org APIs should build a catalog");
        assert!(catalog.channels.len() > 12_000);
        assert!(
            catalog
                .channels
                .iter()
                .map(|channel| channel.sources.len())
                .sum::<usize>()
                > 16_000
        );
        assert!(
            catalog
                .channels
                .iter()
                .filter(|channel| channel.id.starts_with("uncatalogued-"))
                .count()
                > 1_500
        );
        assert!(catalog.categories.len() > 20);
        assert!(catalog.countries.len() > 100);
        assert!(catalog.regions.len() > 20);
        assert!(catalog
            .channels
            .iter()
            .flat_map(|channel| &channel.sources)
            .any(|source| source.referrer.is_some() || source.user_agent.is_some()));
        assert!(!catalog
            .channels
            .iter()
            .flat_map(|channel| &channel.sources)
            .any(|source| source.url.starts_with(ANI_ONE_DEAD_URL)));
        assert!(catalog
            .channels
            .iter()
            .flat_map(|channel| &channel.sources)
            .any(|source| source.url == ANI_ONE_CURRENT_URL));
    }
}

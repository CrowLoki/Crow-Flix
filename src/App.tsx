import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Broadcast,
  CalendarDots,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Clock,
  CloudArrowUp,
  GlobeHemisphereWest,
  Heart,
  House,
  Info,
  ListBullets,
  MagnifyingGlass,
  MapPin,
  Play,
  Plus,
  SpinnerGap,
  Television,
  Translate,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  canonicalCountryCode,
  channelMatchesCountry,
  channelMatchesRegion,
} from "./broadcastArea";
import { mergeChannelsByKey } from "./catalogMerge";
import {
  assertImportFileSize,
  MAX_PLAYLIST_IMPORT_BYTES,
  MAX_XMLTV_IMPORT_BYTES,
} from "./importLimits";
import { migrateStoredChannelKeys } from "./playback/logic";
import {
  usePlaybackController,
  type PlaybackController,
} from "./playback/usePlaybackController";
import type { StreamSource } from "./playback/types";
import WebDestinationsView from "./WebDestinationsView";
import {
  loadWebDestinations,
  mergeWebDestinations,
  normalizeExternalHttpUrl,
  saveWebDestinations,
  upsertWebDestination,
  type WebDestination,
} from "./webDestinations";
import { appendZapDigit, resolveZapNumber, zapTarget } from "./zap";
import "./App.css";

const MASCOT_IMAGE = "/assets/brand/crow-mascot.png";
const BRAND_ICON = "/assets/brand/crow-head.png";
const PAGE_SIZE = 48;

type View = "home" | "live" | "guide" | "web" | "favourites" | "about";
type BrowseMode = "categories" | "countries" | "languages" | "regions";

type Channel = {
  key: string;
  id: string;
  feed?: string | null;
  name: string;
  logo?: string | null;
  categories: string[];
  country?: string | null;
  languages: string[];
  broadcastArea: string[];
  sources: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  format?: string | null;
  network?: string | null;
  website?: string | null;
  isMain: boolean;
};

type NamedOption = { id: string; name: string; description?: string | null; count: number };
type CountryOption = { code: string; name: string; flag: string; languages: string[]; count: number };
type RegionOption = { code: string; name: string; countries: string[]; count: number };
type Catalog = {
  channels: Channel[];
  categories: NamedOption[];
  countries: CountryOption[];
  languages: NamedOption[];
  regions: RegionOption[];
  updatedAt: string;
  source: string;
};
type Programme = {
  channelId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: string;
  stop: string;
};
type GuideResult = {
  programmes: Programme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
};

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

const demoDefinitions = [
  ["Crow News", "news", "AU"], ["World Report", "news", "UK"], ["Pulse 24", "news", "US"],
  ["Cinema One", "movies", "AU"], ["Midnight Movies", "movies", "US"], ["Classic Screen", "classic", "UK"],
  ["Arena Live", "sports", "AU"], ["World Football", "sports", "UK"], ["Velocity", "auto", "DE"],
  ["Wild Earth", "documentary", "CA"], ["Deep Space", "science", "US"], ["Culture House", "culture", "FR"],
  ["Neon Sessions", "music", "JP"], ["Stage Live", "entertainment", "US"], ["Family Central", "family", "NZ"],
  ["Junior Planet", "kids", "AU"], ["World Kitchen", "cooking", "IT"], ["Open Roads", "travel", "NO"],
] as const;

const demoChannels: Channel[] = Array.from({ length: 72 }, (_, index) => {
  const [base, category, country] = demoDefinitions[index % demoDefinitions.length];
  return {
    key: `preview-${index}`, id: `Preview${index}.${country.toLowerCase()}`, name: index < demoDefinitions.length ? base : `${base} ${Math.floor(index / demoDefinitions.length) + 1}`,
    logo: null, categories: [category], country, languages: ["English"], broadcastArea: [`c/${country}`], sources: [],
    feed: null, format: index % 3 === 0 ? "1080p" : "720p", network: "CrowFlix Preview", website: null, isMain: true,
  };
});

function makeDemoProgrammes(channels: Channel[]): Programme[] {
  const titles = ["Morning Brief", "Wild Frontiers", "Live at the Arena", "After Dark", "World Kitchen", "Signal Unknown", "The Big Match", "Northern Lights"];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  return channels.flatMap((channel, channelIndex) => Array.from({ length: 7 }, (_, index) => ({
    channelId: channel.id,
    title: titles[(channelIndex + index) % titles.length],
    description: `Live now on ${channel.name}.`,
    category: titleCase(channel.categories[0]),
    start: new Date(base.getTime() + (index - 2) * 60 * 60 * 1000).toISOString(),
    stop: new Date(base.getTime() + (index - 1) * 60 * 60 * 1000).toISOString(),
  })));
}

const demoCatalog: Catalog = {
  channels: demoChannels,
  categories: [...new Set(demoChannels.flatMap((channel) => channel.categories))].map((id) => ({ id, name: titleCase(id), count: demoChannels.filter((channel) => channel.categories.includes(id)).length })),
  countries: ["AU", "US", "UK", "CA", "DE", "FR", "JP", "NZ", "IT", "NO"].map((code) => ({ code, name: countryName(code), flag: "", languages: ["eng"], count: demoChannels.filter((channel) => channel.country === code).length })),
  languages: [{ id: "English", name: "English", count: demoChannels.length }],
  regions: [{ code: "WORLD", name: "Worldwide", countries: ["AU", "US", "UK", "CA", "DE", "FR", "JP", "NZ", "IT", "NO"], count: demoChannels.length }],
  updatedAt: new Date().toISOString(), source: "CrowFlix browser preview",
};

const emptyCatalog: Catalog = {
  channels: [],
  categories: [],
  countries: [],
  languages: [],
  regions: [],
  updatedAt: "",
  source: "IPTV-org catalogue unavailable",
};

function titleCase(value?: string | null) {
  if (!value) return "Other";
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function countryName(code?: string | null) {
  if (!code) return "Unclassified";
  const canonical = canonicalCountryCode(code);
  const displayCode = canonical === "UK" ? "GB" : canonical;
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(displayCode) || canonical; }
  catch { return canonical; }
}

function preferredCountry() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone.startsWith("Australia/")) return "AU";
  if (zone === "Pacific/Auckland") return "NZ";
  try { return canonicalCountryCode(new Intl.Locale(navigator.language).region) || "AU"; }
  catch { return "AU"; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentProgramme(programmes: Programme[], channelId: string, clock: Date) {
  const now = clock.getTime();
  return programmes.find((item) => item.channelId === channelId && new Date(item.start).getTime() <= now && new Date(item.stop).getTime() > now);
}

function nextProgramme(programmes: Programme[], channelId: string, clock: Date) {
  const now = clock.getTime();
  return programmes.filter((item) => item.channelId === channelId && new Date(item.start).getTime() > now).sort((a, b) => a.start.localeCompare(b.start))[0];
}

function uniqueChannelIds(channels: Channel[]) {
  return [...new Set(channels.map((channel) => channel.id))];
}

function formatTime(value: Date) {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function channelSources(channel: Channel): StreamSource[] {
  if (channel.sources?.length) return channel.sources;
  if (!channel.url) return [];
  return [{
    id: `${channel.key}-legacy`,
    url: channel.url,
    referrer: channel.referrer,
    userAgent: channel.userAgent,
    quality: channel.quality,
    label: channel.label,
    requiresHeaders: Boolean(channel.referrer || channel.userAgent),
  }];
}

function preferredSource(channel: Channel): StreamSource | undefined {
  return channelSources(channel)[0];
}

function channelQuality(channel: Channel): string {
  return preferredSource(channel)?.quality || channel.format || "LIVE";
}

function stored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

export default function App() {
  const isDesktop = Boolean(window.__TAURI_INTERNALS__);
  const [initialWebLibrary] = useState(() =>
    loadWebDestinations(localStorage)
  );
  const [view, setView] = useState<View>("home");
  const [catalog, setCatalog] = useState<Catalog>(
    () => isDesktop ? emptyCatalog : demoCatalog,
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isDesktop);
  const [loadingMessage, setLoadingMessage] = useState("Connecting to IPTV-org…");
  const [query, setQuery] = useState("");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("categories");
  const [category, setCategory] = useState("all");
  const [country, setCountry] = useState("all");
  const [language, setLanguage] = useState("all");
  const [region, setRegion] = useState("all");
  const [guideCountry, setGuideCountry] = useState(preferredCountry());
  const [programmes, setProgrammes] = useState<Programme[]>(
    () => isDesktop ? [] : makeDemoProgrammes(demoChannels),
  );
  const [guideStatus, setGuideStatus] = useState("Preparing the live guide…");
  const [guideLoading, setGuideLoading] = useState(false);
  const [playing, setPlaying] = useState<Channel | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [epgUrl, setEpgUrl] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(new Date());
  const [favourites, setFavourites] = useState<string[]>(() => stored("crowflix:favourites", []));
  const [recent, setRecent] = useState<string[]>(() => stored("crowflix:recent", []));
  const [webDestinations, setWebDestinations] = useState<WebDestination[]>(
    initialWebLibrary.items,
  );
  const webDestinationsRef = useRef<WebDestination[]>(
    initialWebLibrary.items,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideCache = useRef(new Map<string, GuideResult>());
  const skipInitialWebSave = useRef(true);
  const previousChannelKey = useRef<string | null>(null);
  const zapBuffer = useRef("");
  const zapNumberTimer = useRef<number | undefined>(undefined);
  const zapNoticeTimer = useRef<number | undefined>(undefined);
  const [zapNotice, setZapNotice] = useState("");
  const playbackTarget = useMemo(
    () => playing ? { ...playing, sources: channelSources(playing) } : null,
    [playing],
  );
  const playback = usePlaybackController(playbackTarget, videoRef);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  const loadCatalog = useCallback(async (force = false) => {
    if (!isDesktop) return;
    setLoading(true);
    setLoadingMessage(force ? "Refreshing the worldwide catalogue…" : "Loading channels, feeds, logos and regions…");
    try {
      const result = await invoke<Catalog>("load_catalog", { force });
      setCatalog(result);
      setCatalogError(null);
      setGuideCountry((current) => {
        const currentCode = canonicalCountryCode(current);
        const remainsAvailable = result.countries.some(
          (item) => canonicalCountryCode(item.code) === currentCode,
        );
        return remainsAvailable
          ? currentCode
          : canonicalCountryCode(result.countries[0]?.code) || "AU";
      });
      if (force) showToast(`${result.channels.length.toLocaleString()} channels ready · ${result.source}`);
    } catch (error) {
      const message = errorMessage(error);
      setCatalogError(message);
      showToast(message);
    } finally { setLoading(false); }
  }, [isDesktop, showToast]);

  useEffect(() => { void loadCatalog(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem("crowflix:favourites", JSON.stringify(favourites)); }, [favourites]);
  useEffect(() => { localStorage.setItem("crowflix:recent", JSON.stringify(recent)); }, [recent]);
  useEffect(() => {
    if (skipInitialWebSave.current) {
      skipInitialWebSave.current = false;
      return;
    }
    const error = saveWebDestinations(localStorage, webDestinations);
    if (error) showToast(`Web Library could not be saved: ${error}`);
  }, [showToast, webDestinations]);
  useEffect(() => {
    webDestinationsRef.current = webDestinations;
  }, [webDestinations]);
  useEffect(() => {
    if (initialWebLibrary.error) {
      showToast(`CrowFlix recovered the Web Library defaults: ${initialWebLibrary.error}`);
    }
  }, [initialWebLibrary.error, showToast]);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!catalog.channels.length) return;
    const availableKeys = catalog.channels.map((channel) => channel.key);
    const migrate = (items: string[]) => {
      const next = migrateStoredChannelKeys(items, availableKeys);
      return next.length === items.length && next.every((key, index) => key === items[index])
        ? items
        : next;
    };
    setFavourites(migrate);
    setRecent(migrate);
  }, [catalog.channels]);

  const loadGuide = useCallback(async (code: string, force = false) => {
    const targetCountry = canonicalCountryCode(code);
    const countryChannels = catalog.channels.filter(
      (channel) => channelMatchesCountry(
        channel,
        targetCountry,
        catalog.regions,
      ),
    );
    if (!countryChannels.length) { setProgrammes([]); setGuideStatus(`No channels are available for ${countryName(targetCountry)}`); return; }
    const cached = guideCache.current.get(targetCountry);
    if (cached && !force) {
      setProgrammes(cached.programmes);
      setGuideStatus(`${cached.source} · ${cached.matchedChannels.toLocaleString()} channels matched`);
      return;
    }
    if (!isDesktop) {
      const result: GuideResult = { programmes: makeDemoProgrammes(countryChannels), source: "CrowFlix preview guide", matchedChannels: countryChannels.length, updatedAt: new Date().toISOString() };
      guideCache.current.set(targetCountry, result); setProgrammes(result.programmes); setGuideStatus(`${result.source} · live now and up next`); return;
    }
    setGuideLoading(true);
    setGuideStatus(`Matching ${countryName(targetCountry)} channels to IPTV-org programme sources…`);
    try {
      const result = await invoke<GuideResult>("load_auto_epg", { country: targetCountry, channelIds: uniqueChannelIds(countryChannels) });
      guideCache.current.set(targetCountry, result);
      setProgrammes(result.programmes);
      setGuideStatus(`${result.source} · ${result.matchedChannels.toLocaleString()} channels matched`);
    } catch (error) {
      setProgrammes([]);
      setGuideStatus(error instanceof Error ? error.message : String(error));
    } finally { setGuideLoading(false); }
  }, [catalog.channels, catalog.regions, isDesktop]);

  useEffect(() => { if (catalog.channels.length) void loadGuide(guideCountry); }, [catalog.channels, guideCountry, loadGuide]);
  useEffect(() => {
    if (!catalog.channels.length) return;
    const timer = window.setInterval(() => { void loadGuide(guideCountry, true); }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [catalog.channels.length, guideCountry, loadGuide]);

  const play = useCallback((channel: Channel) => {
    setPlaying((current) => {
      if (current && current.key !== channel.key) {
        previousChannelKey.current = current.key;
      }
      return channel;
    });
    setRecent((items) => [channel.key, ...items.filter((key) => key !== channel.key)].slice(0, 24));
  }, []);

  const toggleFavourite = useCallback((channel: Channel) => {
    setFavourites((items) => items.includes(channel.key) ? items.filter((key) => key !== channel.key) : [...items, channel.key]);
  }, []);

  const openWebsite = useCallback(async (url: string, title = "website") => {
    try {
      const normalized = normalizeExternalHttpUrl(url);
      if (!window.__TAURI_INTERNALS__) {
        showToast(`${title} will open in the desktop app`);
        return;
      }
      await invoke("open_web_destination", { url: normalized });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }, [showToast]);

  const saveWebDestination = useCallback((
    item: WebDestination,
    previousId?: string,
  ) => {
    const next = upsertWebDestination(
      webDestinationsRef.current,
      item,
      previousId,
    );
    webDestinationsRef.current = next;
    setWebDestinations(next);
    showToast(previousId ? "Website updated" : "Website added to CrowFlix");
  }, [showToast]);

  const deleteWebDestination = useCallback((item: WebDestination) => {
    const next = webDestinationsRef.current.filter(
      (entry) => entry.id !== item.id,
    );
    webDestinationsRef.current = next;
    setWebDestinations(next);
    showToast(`${item.title} removed from the Web Library`);
  }, [showToast]);

  const importWebDestinations = useCallback((
    imported: WebDestination[],
    filename: string,
  ) => {
    const current = webDestinationsRef.current;
    const merged = mergeWebDestinations(current, imported);
    const added = merged.length - current.length;
    webDestinationsRef.current = merged;
    setWebDestinations(merged);
    showToast(added
      ? `${added.toLocaleString()} website destinations added from ${filename}`
      : `No new website destinations were found in ${filename}`);
  }, [showToast]);

  const importPlaylistUrl = async () => {
    if (!sourceUrl.trim()) return;
    setLoading(true); setLoadingMessage("Adding your playlist…");
    try {
      const custom = await invoke<Channel[]>("load_playlist", { source: sourceUrl.trim() });
      setCatalog((current) => ({ ...current, channels: mergeChannelsByKey(current.channels, custom), source: `${current.source} + custom playlist` }));
      setSourceOpen(false); showToast(`${custom.length.toLocaleString()} personal channels added`);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const importPlaylistFile = async (file: File) => {
    try {
      assertImportFileSize(
        file,
        "playlist",
        MAX_PLAYLIST_IMPORT_BYTES,
      );
      const custom = await invoke<Channel[]>("parse_playlist_text", { text: await file.text() });
      setCatalog((current) => ({ ...current, channels: mergeChannelsByKey(current.channels, custom), source: `${current.source} + ${file.name}` }));
      setSourceOpen(false); showToast(`${custom.length.toLocaleString()} personal channels added`);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  };

  const importEpgUrl = async () => {
    if (!epgUrl.trim()) return;
    setGuideLoading(true);
    try {
      const result = await invoke<GuideResult>("load_epg", { source: epgUrl.trim(), channelIds: uniqueChannelIds(catalog.channels) });
      setProgrammes(result.programmes); setGuideStatus(`${result.source} · ${result.matchedChannels.toLocaleString()} channels matched`);
      setSourceOpen(false); showToast("Personal programme guide loaded");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setGuideLoading(false); }
  };

  const importEpgFile = async (file: File) => {
    try {
      assertImportFileSize(
        file,
        "programme guide",
        MAX_XMLTV_IMPORT_BYTES,
      );
      const result = await invoke<GuideResult>("parse_epg_text", { text: await file.text(), channelIds: uniqueChannelIds(catalog.channels) });
      setProgrammes(result.programmes); setGuideStatus(`${file.name} · ${result.matchedChannels.toLocaleString()} channels matched`);
      setSourceOpen(false); showToast("Personal programme guide loaded");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  };

  const filteredChannels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.channels.filter((channel) => {
      if (
        country !== "all"
        && !channelMatchesCountry(channel, country, catalog.regions)
      ) return false;
      if (category !== "all" && !channel.categories.includes(category)) return false;
      if (language !== "all" && !channel.languages.includes(language)) return false;
      if (
        region !== "all"
        && !channelMatchesRegion(channel, region, catalog.regions)
      ) return false;
      if (needle && !`${channel.name} ${channel.network || ""} ${channel.categories.join(" ")} ${channel.languages.join(" ")} ${countryName(channel.country)}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [catalog.channels, catalog.regions, category, country, language, query, region]);

  const favouriteChannels = useMemo(() => favourites.map((key) => catalog.channels.find((channel) => channel.key === key)).filter(Boolean) as Channel[], [catalog.channels, favourites]);
  const recentChannels = useMemo(() => recent.map((key) => catalog.channels.find((channel) => channel.key === key)).filter(Boolean) as Channel[], [catalog.channels, recent]);
  const localChannels = useMemo(
    () => catalog.channels.filter(
      (channel) => channelMatchesCountry(
        channel,
        preferredCountry(),
        catalog.regions,
      ),
    ),
    [catalog.channels, catalog.regions],
  );
  const sourceCount = useMemo(
    () => catalog.channels.reduce((total, channel) => total + channelSources(channel).length, 0),
    [catalog.channels],
  );
  const hero = localChannels.find((channel) => currentProgramme(programmes, channel.id, clock)) || localChannels[0] || catalog.channels[0];
  const heroNow = hero ? currentProgramme(programmes, hero.id, clock) : undefined;
  const heroNext = hero ? nextProgramme(programmes, hero.id, clock) : undefined;

  const zapKeys = useMemo(
    () => (filteredChannels.length ? filteredChannels : catalog.channels).map((channel) => channel.key),
    [filteredChannels, catalog.channels],
  );
  const announceZap = useCallback((message: string) => {
    setZapNotice(message);
    window.clearTimeout(zapNoticeTimer.current);
    zapNoticeTimer.current = window.setTimeout(() => setZapNotice(""), 1800);
  }, []);
  const zapTo = useCallback((channel: Channel, label?: string) => {
    play(channel);
    announceZap(label || channel.name);
  }, [play, announceZap]);
  const zapStep = useCallback((direction: 1 | -1) => {
    const targetKey = zapTarget(zapKeys, playing?.key ?? null, direction);
    const channel = targetKey ? catalog.channels.find((item) => item.key === targetKey) : undefined;
    if (!channel || !targetKey) return;
    zapTo(channel, `CH ${zapKeys.indexOf(targetKey) + 1} · ${channel.name}`);
  }, [zapKeys, playing?.key, catalog.channels, zapTo]);
  const commitZapNumber = useCallback(() => {
    const buffer = zapBuffer.current;
    zapBuffer.current = "";
    if (!buffer) return;
    const index = resolveZapNumber(buffer, zapKeys.length);
    if (index === null) { announceZap(`No channel ${buffer}`); return; }
    const channel = catalog.channels.find((item) => item.key === zapKeys[index]);
    if (channel) zapTo(channel, `CH ${index + 1} · ${channel.name}`);
  }, [zapKeys, catalog.channels, zapTo, announceZap]);

  useEffect(() => {
    if (!playing) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        zapBuffer.current = appendZapDigit(zapBuffer.current, event.key);
        announceZap(`CH ${zapBuffer.current}…`);
        window.clearTimeout(zapNumberTimer.current);
        zapNumberTimer.current = window.setTimeout(commitZapNumber, 1100);
        return;
      }
      if (event.key === "Enter" && zapBuffer.current) {
        event.preventDefault();
        window.clearTimeout(zapNumberTimer.current);
        commitZapNumber();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") { event.preventDefault(); zapStep(1); return; }
      if (event.key === "ArrowDown" || event.key === "PageDown") { event.preventDefault(); zapStep(-1); return; }
      if ((event.key === "Backspace" || event.key.toLowerCase() === "l") && previousChannelKey.current) {
        event.preventDefault();
        const channel = catalog.channels.find((item) => item.key === previousChannelKey.current);
        if (channel) zapTo(channel, `BACK · ${channel.name}`);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setPlaying(null); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      zapBuffer.current = "";
      window.clearTimeout(zapNumberTimer.current);
    };
  }, [playing, zapStep, commitZapNumber, zapTo, announceZap, catalog.channels]);

  const changeView = (next: View) => { setView(next); window.scrollTo({ top: 0, behavior: "smooth" }); };

  return (
    <div className="app-shell">
      <Header view={view} onView={changeView} query={query} onQuery={(value) => { setQuery(value); if (value && view !== "web") setView("live"); }} onSource={() => setSourceOpen(true)} />
      {loading && <LoadingOverlay message={loadingMessage} />}
      {catalogError && <CatalogErrorBanner message={catalogError} hasCatalog={catalog.channels.length > 0} loading={loading} onRetry={() => void loadCatalog(catalog.channels.length > 0)} />}
      <main>
        {view === "home" && <HomeView channels={catalog.channels} programmes={programmes} clock={clock} hero={hero} heroNow={heroNow} heroNext={heroNext} recent={recentChannels} favourites={favourites} onPlay={play} onFavourite={toggleFavourite} onInfo={() => setView("guide")} />}
        {view === "live" && <LiveView catalog={catalog} channels={filteredChannels} mode={browseMode} setMode={setBrowseMode} category={category} setCategory={setCategory} country={country} setCountry={setCountry} language={language} setLanguage={setLanguage} region={region} setRegion={setRegion} favourites={favourites} programmes={programmes} clock={clock} onPlay={play} onFavourite={toggleFavourite} />}
        {view === "guide" && <GuideView catalog={catalog} country={guideCountry} setCountry={setGuideCountry} programmes={programmes} clock={clock} status={guideStatus} loading={guideLoading} onRefresh={() => void loadGuide(guideCountry, true)} onPlay={play} />}
        {view === "web" && <WebDestinationsView items={webDestinations} query={query} onOpen={(item) => void openWebsite(item.url, item.title)} onSave={saveWebDestination} onDelete={deleteWebDestination} onImport={importWebDestinations} onMessage={showToast} />}
        {view === "favourites" && <FavouritesView channels={favouriteChannels} favourites={favourites} programmes={programmes} clock={clock} onPlay={play} onFavourite={toggleFavourite} onBrowse={() => setView("live")} />}
        {view === "about" && <AboutView onOpen={(url, title) => void openWebsite(url, title)} />}
      </main>
      {view === "web"
        ? <footer className="status-bar"><span><GlobeHemisphereWest weight="fill" /> {webDestinations.length.toLocaleString()} website destinations</span><span>Saved on this device · JSON backup available</span></footer>
        : view === "about"
          ? <footer className="status-bar"><span><Info weight="fill" /> CrowFlix 0.5.1</span><span>Copyright © 2026 Crow · AGPL-3.0-only</span></footer>
        : <footer className="status-bar"><span><Broadcast weight="fill" /> {catalog.channels.length.toLocaleString()} channels · {sourceCount.toLocaleString()} sources</span><span>{catalog.source}</span><button onClick={() => void loadCatalog(true)}><ArrowsClockwise /> Refresh catalogue</button></footer>}
      {playing && <Player channel={playing} now={currentProgramme(programmes, playing.id, clock)} next={nextProgramme(programmes, playing.id, clock)} playback={playback} videoRef={videoRef} zapNotice={zapNotice} onOpenWebsite={(url, title) => void openWebsite(url, title)} onClose={() => setPlaying(null)} />}
      {sourceOpen && <SourceDialog sourceUrl={sourceUrl} setSourceUrl={setSourceUrl} epgUrl={epgUrl} setEpgUrl={setEpgUrl} loading={loading || guideLoading} onClose={() => setSourceOpen(false)} onPlaylistUrl={() => void importPlaylistUrl()} onPlaylistFile={(file) => void importPlaylistFile(file)} onEpgUrl={() => void importEpgUrl()} onEpgFile={(file) => void importEpgFile(file)} />}
      {toast && <div className="toast"><CheckCircle weight="fill" />{toast}</div>}
    </div>
  );
}

function Header({ view, onView, query, onQuery, onSource }: { view: View; onView: (view: View) => void; query: string; onQuery: (value: string) => void; onSource: () => void }) {
  const nav: Array<[View, string, React.ReactNode]> = [["home", "Home", <House />], ["live", "Live TV", <Broadcast />], ["guide", "Guide", <CalendarDots />], ["web", "Web Library", <GlobeHemisphereWest />], ["favourites", "My List", <Heart />], ["about", "About", <Info />]];
  return <header className="topbar">
    <button className="brand" onClick={() => onView("home")}><img src={BRAND_ICON} alt="" /><span>CROW<strong>FLIX</strong></span></button>
    <nav>{nav.map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => onView(id)}>{icon}<span>{label}</span></button>)}</nav>
    <div className="header-actions"><label className="search"><MagnifyingGlass /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={view === "web" ? "Search websites" : "Search the world"} />{query && <button aria-label="Clear search" onClick={() => onQuery("")}><X /></button>}</label><button className="source-button" onClick={onSource}><Plus /><span>Add source</span></button></div>
  </header>;
}

function CatalogErrorBanner({ message, hasCatalog, loading, onRetry }: { message: string; hasCatalog: boolean; loading: boolean; onRetry: () => void }) {
  return <section className="catalog-error-banner" role="alert" aria-live="assertive">
    <WarningCircle weight="fill" />
    <div>
      <strong>{hasCatalog ? "Catalogue refresh failed" : "Live catalogue could not be loaded"}</strong>
      <span>{message}{hasCatalog ? " The previously loaded channels remain available." : ""}</span>
    </div>
    <button onClick={onRetry} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : <ArrowsClockwise />} Retry</button>
  </section>;
}

function HomeView({ channels, programmes, clock, hero, heroNow, heroNext, recent, favourites, onPlay, onFavourite, onInfo }: { channels: Channel[]; programmes: Programme[]; clock: Date; hero?: Channel; heroNow?: Programme; heroNext?: Programme; recent: Channel[]; favourites: string[]; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onInfo: () => void }) {
  const rail = (category: string) => channels.filter((channel) => channel.categories.includes(category)).slice(0, 24);
  if (!hero) {
    return <div className="home-view">
      <section className="hero">
        <img className="hero-art" src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
        <div className="hero-vignette" />
        <div className="hero-copy">
          <span className="overline"><WarningCircle weight="fill" /> Catalogue unavailable</span>
          <h1>No live channels loaded</h1>
          <p>CrowFlix has not substituted preview channels. Retry the catalogue connection above or add a personal source.</p>
        </div>
      </section>
    </div>;
  }
  return <div className="home-view">
    <section className="hero">
      <img className="hero-art" src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
      <div className="hero-vignette" />
      <div className="hero-copy">
        <span className="overline"><Broadcast weight="fill" /> Live now</span>
        <h1>{heroNow?.title || hero.name}</h1>
        <div className="hero-meta"><strong>{hero.name}</strong><span>{channelQuality(hero)}</span><span>{countryName(hero.country)}</span><span>{titleCase(hero.categories[0])}</span></div>
        <p>{heroNow?.description || `Watch ${hero.name} live from the worldwide CrowFlix channel catalogue.`}</p>
        {heroNext && <div className="up-next"><Clock /><span><small>UP NEXT · {formatTime(new Date(heroNext.start))}</small><strong>{heroNext.title}</strong></span></div>}
        <div className="hero-actions"><button className="primary" onClick={() => onPlay(hero)}><Play weight="fill" /> Watch live</button><button className="secondary" onClick={onInfo}><Info /> Open guide</button><button className="icon-button" aria-label="Toggle featured channel favourite" onClick={() => onFavourite(hero)}><Heart weight={favourites.includes(hero.key) ? "fill" : "regular"} /></button></div>
      </div>
    </section>
    <div className="home-content">
      {recent.length > 0 && <ChannelRail title="Continue watching" channels={recent} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />}
      <ChannelRail title="Live news" channels={rail("news")} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />
      <ChannelRail title="Movies on now" channels={rail("movies")} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />
      <ChannelRail title="Live sports" channels={rail("sports")} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />
      <ChannelRail title="Documentaries and discovery" channels={[...rail("documentary"), ...rail("science")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />
      <ChannelRail title="Music and entertainment" channels={[...rail("music"), ...rail("entertainment")].slice(0, 24)} programmes={programmes} clock={clock} favourites={favourites} onPlay={onPlay} onFavourite={onFavourite} />
    </div>
  </div>;
}

function ChannelRail({ title, channels, programmes, clock, favourites, onPlay, onFavourite }: { title: string; channels: Channel[]; programmes: Programme[]; clock: Date; favourites: string[]; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void }) {
  const railRef = useRef<HTMLDivElement>(null);
  if (!channels.length) return null;
  return <section className="rail-section"><div className="section-heading"><h2>{title}</h2><span>{channels.length.toLocaleString()} channels</span></div><div className="rail-wrap"><button className="rail-arrow left" aria-label={`Scroll ${title} left`} onClick={() => railRef.current?.scrollBy({ left: -900, behavior: "smooth" })}><CaretLeft /></button><div className="channel-rail" ref={railRef}>{channels.map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} />)}</div><button className="rail-arrow right" aria-label={`Scroll ${title} right`} onClick={() => railRef.current?.scrollBy({ left: 900, behavior: "smooth" })}><CaretRight /></button></div></section>;
}

function ChannelCard({ channel, programme, favourite, onPlay, onFavourite }: { channel: Channel; programme?: Programme; favourite: boolean; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void }) {
  return <article className="channel-card"><button className="card-main" onClick={() => onPlay(channel)}><div className="card-image">{channel.logo ? <img src={channel.logo} alt="" onError={(event) => { event.currentTarget.src = BRAND_ICON; event.currentTarget.className = "fallback-logo"; }} /> : <img className="fallback-logo" src={BRAND_ICON} alt="" />}<span className="live-badge">LIVE</span><span className="quality-badge">{channelQuality(channel)}</span><span className="play-overlay"><Play weight="fill" /></span></div><div className="card-copy"><strong>{programme?.title || channel.name}</strong><span>{channel.name}</span><small>{countryName(channel.country)} · {titleCase(channel.categories[0])}</small></div></button><button className="heart-button" onClick={() => onFavourite(channel)} aria-label={`Toggle ${channel.name} favourite`}><Heart weight={favourite ? "fill" : "regular"} /></button></article>;
}

function LiveView({ catalog, channels, mode, setMode, category, setCategory, country, setCountry, language, setLanguage, region, setRegion, favourites, programmes, clock, onPlay, onFavourite }: { catalog: Catalog; channels: Channel[]; mode: BrowseMode; setMode: (mode: BrowseMode) => void; category: string; setCategory: (value: string) => void; country: string; setCountry: (value: string) => void; language: string; setLanguage: (value: string) => void; region: string; setRegion: (value: string) => void; favourites: string[]; programmes: Programme[]; clock: Date; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(channels.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const matchingSources = channels.reduce((total, channel) => total + channelSources(channel).length, 0);
  useEffect(() => setPage(1), [category, country, language, region, channels.length]);
  const modeOptions = mode === "categories" ? catalog.categories.slice(0, 40) : mode === "countries" ? catalog.countries.slice(0, 80).map((item) => ({ id: item.code, name: `${item.flag} ${item.name}`, count: item.count })) : mode === "languages" ? catalog.languages.slice(0, 60) : catalog.regions.map((item) => ({ id: item.code, name: item.name, count: item.count }));
  const selected = mode === "categories" ? category : mode === "countries" ? country : mode === "languages" ? language : region;
  const select = (value: string) => { if (mode === "categories") setCategory(value); if (mode === "countries") setCountry(value); if (mode === "languages") setLanguage(value); if (mode === "regions") setRegion(value); };
  const clearAll = () => { setCategory("all"); setCountry("all"); setLanguage("all"); setRegion("all"); };
  return <div className="browse-page">
    <div className="page-hero"><div><span className="overline"><Television /> Worldwide live television</span><h1>Browse Live TV</h1><p>Every available channel, organized with IPTV-org feed and regional metadata.</p></div><div className="catalog-number"><strong>{channels.length.toLocaleString()}</strong><span>channels · {matchingSources.toLocaleString()} sources</span></div></div>
    <div className="browse-layout"><aside className="browse-sidebar"><h3>Explore by</h3>{([["categories", <ListBullets />, "Categories"], ["countries", <GlobeHemisphereWest />, "Countries"], ["languages", <Translate />, "Languages"], ["regions", <MapPin />, "Regions"]] as Array<[BrowseMode, React.ReactNode, string]>).map(([id, icon, label]) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{icon}<span>{label}</span><CaretRight /></button>)}<div className="active-filters"><span>Active filters</span>{category !== "all" && <b>{titleCase(category)}</b>}{country !== "all" && <b>{countryName(country)}</b>}{language !== "all" && <b>{language}</b>}{region !== "all" && <b>{catalog.regions.find((item) => item.code === region)?.name || region}</b>}<button onClick={clearAll}>Clear all</button></div></aside>
      <section className="browse-results"><div className="filter-strip"><button className={selected === "all" ? "active" : ""} onClick={() => select("all")}>All</button>{modeOptions.map((item) => <button key={item.id} className={selected === item.id ? "active" : ""} onClick={() => select(item.id)}><span>{item.name}</span><small>{item.count.toLocaleString()}</small></button>)}</div><div className="result-heading"><div><h2>{selected === "all" ? `All ${titleCase(mode)}` : modeOptions.find((item) => item.id === selected)?.name}</h2><span>Showing {channels.length ? (safePage - 1) * PAGE_SIZE + 1 : 0}–{Math.min(safePage * PAGE_SIZE, channels.length)} of {channels.length.toLocaleString()}</span></div></div>{channels.length ? <><div className="channel-grid">{channels.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE).map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} />)}</div><Pagination page={safePage} pageCount={pageCount} onPage={setPage} /></> : <EmptyState title="No matching channels" copy="Clear a filter or search for something else." />}</section></div>
  </div>;
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  return <div className="pagination"><button disabled={page <= 1} onClick={() => onPage(page - 1)}><CaretLeft /> Previous</button><span>Page <strong>{page.toLocaleString()}</strong> of {pageCount.toLocaleString()}</span><button disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next <CaretRight /></button></div>;
}

function GuideView({ catalog, country, setCountry, programmes, clock, status, loading, onRefresh, onPlay }: { catalog: Catalog; country: string; setCountry: (value: string) => void; programmes: Programme[]; clock: Date; status: string; loading: boolean; onRefresh: () => void; onPlay: (channel: Channel) => void }) {
  const countryChannels = catalog.channels.filter(
    (channel) => channelMatchesCountry(channel, country, catalog.regions),
  );
  const byChannel = useMemo(() => { const map = new Map<string, Programme[]>(); programmes.forEach((item) => map.set(item.channelId, [...(map.get(item.channelId) || []), item])); return map; }, [programmes]);
  const channels = [...countryChannels].sort((a, b) => Number(byChannel.has(b.id)) - Number(byChannel.has(a.id)) || a.name.localeCompare(b.name)).slice(0, 140);
  const start = new Date(clock); start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const times = Array.from({ length: 9 }, (_, index) => new Date(start.getTime() + index * 30 * 60 * 1000));
  return <div className="guide-page"><div className="page-hero guide-title"><div><span className="overline"><CalendarDots /> Live programme guide</span><h1>What’s on now</h1><p>{clock.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p></div><div className="guide-controls"><label><span>Guide region</span><select value={canonicalCountryCode(country)} onChange={(event) => setCountry(canonicalCountryCode(event.target.value))}>{catalog.countries.map((item) => <option key={item.code} value={canonicalCountryCode(item.code)}>{item.flag} {item.name} ({item.count.toLocaleString()})</option>)}</select></label><button onClick={onRefresh} disabled={loading}><ArrowsClockwise className={loading ? "spin" : ""} /> Refresh</button></div></div><div className="guide-status"><span className="signal-dot" /><strong>{loading ? "Updating live programme data…" : status}</strong><span>{byChannel.size.toLocaleString()} channels with listings</span></div><div className="guide-shell"><div className="guide-times"><div>Channel</div>{times.map((time) => <span key={time.toISOString()}>{formatTime(time)}</span>)}</div><div className="guide-now-line" style={{ left: `calc(260px + ${((clock.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100}% * (1 - 260px / 100%))` }}><b>NOW</b></div>{channels.map((channel) => { const items = (byChannel.get(channel.id) || []).filter((item) => new Date(item.stop) > start && new Date(item.start) < end); return <div className="guide-row" key={channel.key}><button className="guide-channel" onClick={() => onPlay(channel)}>{channel.logo ? <img src={channel.logo} alt="" /> : <img src={BRAND_ICON} alt="" />}<span><strong>{channel.name}</strong><small>{titleCase(channel.categories[0])}</small></span></button><div className="programme-track">{items.length ? items.map((item) => { const itemStart = Math.max(start.getTime(), new Date(item.start).getTime()); const itemEnd = Math.min(end.getTime(), new Date(item.stop).getTime()); const left = ((itemStart - start.getTime()) / (end.getTime() - start.getTime())) * 100; const width = ((itemEnd - itemStart) / (end.getTime() - start.getTime())) * 100; const live = new Date(item.start) <= clock && new Date(item.stop) > clock; return <button key={`${item.channelId}-${item.start}`} className={live ? "live" : ""} style={{ left: `${left}%`, width: `${width}%` }} onClick={() => onPlay(channel)}><strong>{item.title}</strong><small>{formatTime(new Date(item.start))}–{formatTime(new Date(item.stop))}</small></button>; }) : <button className="no-listing" onClick={() => onPlay(channel)}><strong>Live broadcast</strong><small>Programme details unavailable</small></button>}</div></div>; })}</div>{!loading && !programmes.length && <EmptyState title="No programme listings matched" copy="The channels remain available to watch live while CrowFlix refreshes guide sources." />}</div>;
}

function FavouritesView({ channels, favourites, programmes, clock, onPlay, onFavourite, onBrowse }: { channels: Channel[]; favourites: string[]; programmes: Programme[]; clock: Date; onPlay: (channel: Channel) => void; onFavourite: (channel: Channel) => void; onBrowse: () => void }) {
  return <div className="browse-page"><div className="page-hero"><div><span className="overline"><Heart weight="fill" /> Your CrowFlix library</span><h1>My List</h1><p>Your saved live channels, ready whenever you are.</p></div><div className="catalog-number"><strong>{channels.length}</strong><span>saved channels</span></div></div>{channels.length ? <div className="channel-grid standalone-grid">{channels.map((channel) => <ChannelCard key={channel.key} channel={channel} programme={currentProgramme(programmes, channel.id, clock)} favourite={favourites.includes(channel.key)} onPlay={onPlay} onFavourite={onFavourite} />)}</div> : <EmptyState title="Your list is waiting" copy="Save channels from Home or Live TV and they will appear here." action="Browse live TV" onAction={onBrowse} />}</div>;
}

function AboutView({ onOpen }: { onOpen: (url: string, title: string) => void }) {
  const links = [
    ["Source code", "https://github.com/CrowLoki/Crow-Flix"],
    ["Software licence", "https://github.com/CrowLoki/Crow-Flix/blob/main/LICENSE"],
    ["Licensing details", "https://github.com/CrowLoki/Crow-Flix/blob/main/LICENSING.md"],
    ["Third-party notices", "https://github.com/CrowLoki/Crow-Flix/blob/main/THIRD_PARTY_NOTICES.md"],
    ["Privacy", "https://github.com/CrowLoki/Crow-Flix/blob/main/PRIVACY.md"],
    ["Security", "https://github.com/CrowLoki/Crow-Flix/blob/main/SECURITY.md"],
  ] as const;

  return <section className="about-view">
    <div className="about-intro">
      <img src={MASCOT_IMAGE} alt="CrowFlix cybernetic crow mascot" />
      <div>
        <span className="overline"><Info weight="fill" /> About CrowFlix</span>
        <h1>CrowFlix <strong>0.5.1</strong></h1>
        <p>A cinematic desktop IPTV player, programme guide, and user-managed web library built with Tauri, Rust, React, and TypeScript.</p>
      </div>
    </div>
    <div className="about-grid">
      <article>
        <h2>Free software</h2>
        <p>Copyright © 2026 Crow. CrowFlix source code and documentation are licensed under the GNU Affero General Public License version 3 only.</p>
        <p>This program comes with absolutely no warranty. See the licence for the complete terms and your rights to obtain, study, modify, and share the source.</p>
      </article>
      <article>
        <h2>Brand and external services</h2>
        <p>The Crow name, mascot, icons, custom fonts, and cursor artwork have separate brand terms and are not licensed under the AGPL.</p>
        <p>CrowFlix does not host television channels or media. Catalogue, guide, stream, artwork, and website providers are independent services with their own availability and terms.</p>
      </article>
    </div>
    <div className="about-links">
      {links.map(([label, url]) => <button key={url} onClick={() => onOpen(url, label)}><ArrowSquareOut />{label}</button>)}
    </div>
  </section>;
}

function Player({
  channel,
  now,
  next,
  playback,
  videoRef,
  zapNotice,
  onOpenWebsite,
  onClose,
}: {
  channel: Channel;
  now?: Programme;
  next?: Programme;
  playback: PlaybackController;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  zapNotice: string;
  onOpenWebsite: (url: string, title: string) => void;
  onClose: () => void;
}) {
  const source = playback.source;
  const latestDiagnostic = playback.diagnostics[playback.diagnostics.length - 1];
  const busy = playback.status === "loading" || playback.status === "switching";
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimer = useRef<number | undefined>(undefined);
  const interactive = busy || playback.status === "failed" || playback.status === "interaction-required";
  const wake = useCallback(() => {
    setChromeVisible(true);
    window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), 3200);
  }, []);
  useEffect(() => {
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.clearTimeout(chromeTimer.current);
    };
  }, [wake]);
  useEffect(() => {
    if (interactive || zapNotice) {
      setChromeVisible(true);
      window.clearTimeout(chromeTimer.current);
    } else {
      wake();
    }
  }, [interactive, zapNotice, wake]);
  let channelWebsite = "";
  try {
    channelWebsite = channel.website
      ? normalizeExternalHttpUrl(channel.website)
      : "";
  } catch {
    channelWebsite = "";
  }
  return <div className={chromeVisible ? "player" : "player chrome-hidden"}>
    <div className="player-ambient" />
    <video ref={videoRef} controls autoPlay playsInline poster={MASCOT_IMAGE} />
    <div className="player-shade" />
    <div className="player-top">
      <button onClick={onClose}><CaretLeft /> Back to CrowFlix</button>
      <div className="player-source-state" aria-live="polite">
        {playback.sourceTotal > 0 && <span>Source {playback.sourceNumber}/{playback.sourceTotal}</span>}
        <i className={playback.status === "playing" ? "online" : ""} />
        {playback.status === "playing" ? "Live" : titleCase(playback.status)}
      </div>
      {playback.canNext && <button className="player-next-source" onClick={playback.next} title="Try the next available source">Next source <CaretRight /></button>}
      <div className="player-brand"><img src={BRAND_ICON} alt="" />CROW<strong>FLIX</strong></div>
    </div>
    {zapNotice && <div className="zap-osd" role="status">{zapNotice}</div>}
    <div className="player-keys" aria-hidden="true">↑↓ Channel · 0-9 Direct · L Last · Esc Close</div>
    <div className="player-info">
      <span className="overline"><Broadcast weight="fill" /> Live · {countryName(channel.country)}</span>
      <h1>{now?.title || channel.name}</h1>
      <h2>{channel.name}</h2>
      {now?.description && <p>{now.description}</p>}
      <div className="player-tags">
        <span>{source?.quality || channelQuality(channel)}</span>
        {channel.categories.map((item) => <span key={item}>{titleCase(item)}</span>)}
        {(source?.label || source?.title) && <span>{source.label || source.title}</span>}
      </div>
      {channelWebsite && <button className="player-website" onClick={() => onOpenWebsite(channelWebsite, channel.name)}><ArrowSquareOut weight="bold" /> Open {new URL(channelWebsite).hostname.replace(/^www\./i, "")}</button>}
      {next && <div className="up-next"><Clock /><span><small>UP NEXT · {formatTime(new Date(next.start))}</small><strong>{next.title}</strong></span></div>}
    </div>
    {busy && <div className="player-status" aria-live="polite">
      <SpinnerGap className="spin" />
      <strong>{playback.status === "switching" ? "Finding a working source" : "Starting live playback"}</strong>
      <span>{playback.message}</span>
    </div>}
    {playback.status === "interaction-required" && <div className="player-error player-prompt">
      <Play weight="fill" />
      <h2>Ready when you are</h2>
      <p>{playback.message}</p>
      <div className="player-error-actions"><button onClick={playback.resume}><Play weight="fill" /> Play now</button><button className="quiet" onClick={onClose}>Return</button></div>
    </div>}
    {playback.status === "failed" && <div className="player-error">
      <WarningCircle weight="fill" />
      <h2>{playback.sourceTotal ? "Every available source failed" : "No live source in this preview"}</h2>
      <p>{playback.message}</p>
      <div className="player-error-actions">
        <button onClick={playback.retry}><ArrowsClockwise /> Retry</button>
        {playback.canNext && <button onClick={playback.next}><CaretRight /> Next source</button>}
        <button className="quiet" onClick={onClose}>Return</button>
      </div>
      {latestDiagnostic && <details className="player-diagnostics">
        <summary>Playback details</summary>
        <code>{latestDiagnostic.transport.toUpperCase()} · {latestDiagnostic.reason} · {latestDiagnostic.endpoint}</code>
        <small>No credentials, headers, paths, or URL query values are included.</small>
      </details>}
    </div>}
  </div>;
}

function SourceDialog({ sourceUrl, setSourceUrl, epgUrl, setEpgUrl, loading, onClose, onPlaylistUrl, onPlaylistFile, onEpgUrl, onEpgFile }: { sourceUrl: string; setSourceUrl: (value: string) => void; epgUrl: string; setEpgUrl: (value: string) => void; loading: boolean; onClose: () => void; onPlaylistUrl: () => void; onPlaylistFile: (file: File) => void; onEpgUrl: () => void; onEpgFile: (file: File) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="source-dialog" role="dialog" aria-modal="true" aria-labelledby="source-dialog-title"><button className="dialog-close" aria-label="Close source dialog" onClick={onClose}><X /></button><span className="overline"><CloudArrowUp /> Optional personal sources</span><h2 id="source-dialog-title">Expand CrowFlix</h2><p>The worldwide IPTV-org catalogue and programme guide are already included. Add your own source only when you want more.</p><div className="source-section"><label>Personal M3U playlist URL</label><div><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/playlist.m3u" /><button onClick={onPlaylistUrl} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : "Add"}</button></div><label className="file-control"><CloudArrowUp /> Choose M3U file<input type="file" accept=".m3u,.m3u8,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) onPlaylistFile(file); }} /></label></div><div className="source-section"><label>Personal XMLTV guide URL</label><div><input value={epgUrl} onChange={(event) => setEpgUrl(event.target.value)} placeholder="https://example.com/guide.xml" /><button onClick={onEpgUrl} disabled={loading}>{loading ? <SpinnerGap className="spin" /> : "Add"}</button></div><label className="file-control"><CalendarDots /> Choose XMLTV file<input type="file" accept=".xml,.xmltv,text/xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) onEpgFile(file); }} /></label></div></section></div>;
}

function LoadingOverlay({ message }: { message: string }) { return <div className="loading-overlay"><img src={BRAND_ICON} alt="" /><div className="loading-ring" /><h2>{message}</h2><p>Building your live television universe</p></div>; }

function EmptyState({ title, copy, action, onAction }: { title: string; copy: string; action?: string; onAction?: () => void }) { return <div className="empty-state"><img src={BRAND_ICON} alt="" /><h2>{title}</h2><p>{copy}</p>{action && <button className="primary" onClick={onAction}>{action}</button>}</div>; }

import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  DownloadSimple,
  GlobeHemisphereWest,
  LinkSimple,
  PencilSimple,
  Plus,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import {
  MAX_WEB_DESTINATION_IMPORT_BYTES,
  approvedWebDestinationArtwork,
  filterWebDestinations,
  normalizeWebDestination,
  parseWebDestinationImport,
  serializeWebDestinations,
  webDestinationArtworkApprovalKey,
  webDestinationHostname,
  type WebDestination,
  type WebDestinationDraft,
} from "./webDestinations";

const BRAND_ICON = "/assets/brand/crow-head.png";

type Props = {
  items: WebDestination[];
  query: string;
  onOpen: (item: WebDestination) => void;
  onSave: (item: WebDestination, previousId?: string) => void;
  onDelete: (item: WebDestination) => void;
  onImport: (items: WebDestination[], filename: string) => void;
  onMessage: (message: string) => void;
};

const EMPTY_DRAFT: WebDestinationDraft = {
  title: "",
  url: "",
  category: "Movies & TV",
  artwork: "",
  note: "",
  sourceDirectory: "",
  sourcePage: "",
};

export default function WebDestinationsView({
  items,
  query,
  onOpen,
  onSave,
  onDelete,
  onImport,
  onMessage,
}: Props) {
  const [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<WebDestination | null>(null);
  const [adding, setAdding] = useState(false);
  const [visibleArtwork, setVisibleArtwork] = useState<Set<string>>(
    () => new Set(),
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const categories = item.categories?.length
        ? item.categories
        : [item.category];
      for (const category of new Set(categories)) {
        counts.set(category, (counts.get(category) || 0) + 1);
      }
    }
    return [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
  }, [items]);
  const visible = useMemo(
    () => filterWebDestinations(items, query, category),
    [category, items, query],
  );

  const exportLibrary = () => {
    const blob = new Blob([serializeWebDestinations(items)], {
      type: "application/json",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "crowflix-web-library.json";
    anchor.click();
    URL.revokeObjectURL(href);
    onMessage("Web Library backup created");
  };

  const importLibrary = async (file: File) => {
    try {
      if (file.size > MAX_WEB_DESTINATION_IMPORT_BYTES) {
        throw new Error("That website backup is larger than 2 MB.");
      }
      const imported = parseWebDestinationImport(await file.text());
      onImport(imported, file.name);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return <div className="browse-page web-library">
    <div className="page-hero web-hero">
      <div>
        <span className="overline"><GlobeHemisphereWest /> Your link-out entertainment hub</span>
        <h1>Web Library</h1>
        <p>Open saved entertainment websites in your normal browser. Website pages stay separate from direct live streams.</p>
      </div>
      <div className="web-hero-actions">
        <div className="catalog-number"><strong>{visible.length.toLocaleString()}</strong><span>website destinations</span></div>
        <button className="secondary" onClick={() => setAdding(true)}><Plus /> Add website</button>
        <label className="secondary file-action"><UploadSimple /> Import JSON<input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLibrary(file); event.currentTarget.value = ""; }} /></label>
        <button className="secondary" onClick={exportLibrary}><DownloadSimple /> Export JSON</button>
      </div>
    </div>

    <div className="web-category-strip" aria-label="Website categories">
      <button className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>All <small>{items.length}</small></button>
      {categoryCounts.map(([item, count]) => {
        return <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item} <small>{count}</small></button>;
      })}
    </div>

    {visible.length ? <div className="web-card-grid">
      {visible.map((item) => {
        const approvedArtwork = approvedWebDestinationArtwork(
          item,
          visibleArtwork,
        );
        const showRemoteArtwork = Boolean(approvedArtwork);
        const artworkHostname = item.artwork
          ? new URL(item.artwork).hostname.replace(/^www\./i, "")
          : "";
        return <article className="web-card" key={item.id}>
        <div className="web-card-art">
          <img
            src={approvedArtwork || BRAND_ICON}
            className={showRemoteArtwork ? "" : "web-card-fallback"}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.src = BRAND_ICON;
              event.currentTarget.className = "web-card-fallback";
              setVisibleArtwork((current) => {
                const next = new Set(current);
                const key = webDestinationArtworkApprovalKey(item);
                if (key) next.delete(key);
                return next;
              });
            }}
          />
          <span>{(item.categories?.length
            ? item.categories
            : [item.category]
          ).join(" / ")}</span>
          {item.artwork && !showRemoteArtwork && <button
            className="web-artwork-load"
            onClick={() => {
              const key = webDestinationArtworkApprovalKey(item);
              if (key) {
                setVisibleArtwork((current) => new Set(current).add(key));
              }
            }}
          >
            Load artwork from {artworkHostname}
          </button>}
        </div>
        <div className="web-card-copy">
          <small><LinkSimple /> {webDestinationHostname(item)}</small>
          <h2>{item.title}</h2>
          {item.note && <p>{item.note}</p>}
          {item.sourceDirectory && <em>From {item.sourceDirectory}</em>}
        </div>
        <div className="web-card-actions">
          <button className="primary" onClick={() => onOpen(item)}><ArrowSquareOut weight="bold" /> Open website</button>
          <button className="icon-button" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)}><PencilSimple /></button>
          <button className="icon-button danger" aria-label={`Delete ${item.title}`} onClick={() => {
            if (window.confirm(`Remove "${item.title}" from your Web Library?`)) onDelete(item);
          }}><Trash /></button>
        </div>
      </article>;
      })}
    </div> : <div className="empty-state">
      <img src={BRAND_ICON} alt="" />
      <h2>No matching websites</h2>
      <p>Change the category or search, or add the exact page you want CrowFlix to open.</p>
      <button className="primary" onClick={() => setAdding(true)}><Plus /> Add website</button>
    </div>}

    {(adding || editing) && <WebDestinationEditor
      initial={editing || EMPTY_DRAFT}
      onClose={() => { setAdding(false); setEditing(null); }}
      onSave={(item) => {
        onSave(item, editing?.id);
        setAdding(false);
        setEditing(null);
      }}
    />}
  </div>;
}

function WebDestinationEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: WebDestinationDraft;
  onClose: () => void;
  onSave: (item: WebDestination) => void;
}) {
  const [draft, setDraft] = useState<WebDestinationDraft>({ ...initial });
  const [error, setError] = useState("");
  const update = (field: keyof WebDestinationDraft, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "category" ? { categories: undefined } : {}),
    }));
  };
  const submit = () => {
    try {
      onSave(normalizeWebDestination(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="source-dialog web-editor" role="dialog" aria-modal="true" aria-label={initial.id ? "Edit website" : "Add website"}>
      <button className="dialog-close" onClick={onClose} aria-label="Close website editor"><X /></button>
      <span className="overline"><LinkSimple /> Web Library</span>
      <h2>{initial.id ? "Edit website" : "Add a website"}</h2>
      <p>Save the exact page you want. CrowFlix will open it in your default browser only when you press its button.</p>
      <label><span>Title</span><input value={draft.title} maxLength={160} onChange={(event) => update("title", event.target.value)} placeholder="Example: My movie site" /></label>
      <label><span>Website address</span><input value={draft.url} maxLength={8192} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/watch" /></label>
      <div className="dialog-columns">
        <label><span>Category</span><input value={draft.category} maxLength={80} onChange={(event) => update("category", event.target.value)} placeholder="Movies & TV" /></label>
        <label><span>Artwork address (optional; loads only when clicked)</span><input value={draft.artwork || ""} maxLength={8192} onChange={(event) => update("artwork", event.target.value)} placeholder="https://example.com/poster.jpg" /></label>
      </div>
      <label><span>Note (optional)</span><textarea value={draft.note || ""} maxLength={500} onChange={(event) => update("note", event.target.value)} placeholder="Anything you want to remember about this destination" /></label>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={submit}>{initial.id ? "Save changes" : "Add to Web Library"}</button></div>
    </section>
  </div>;
}

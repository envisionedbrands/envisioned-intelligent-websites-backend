'use client';

/**
 * Browser-only canvas loaded by the static /studio/workspace shell.
 *
 * Poppy semantics: edges ARE context. Paste a URL anywhere on the canvas to
 * ingest it as a source node; wire sources (or groups of them) into a desk;
 * open the desk to write with exactly that context. Autosaves 1.2s after the
 * last change; pending sources poll until the runner lands them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  addEdge,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type EdgeProps,
  type Connection,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_TYPES, type SourceInfo, type DeskInfo } from '@/components/studio/nodes';
import { DeskPanel } from '@/components/studio/desk-panel';
import { EmailReview } from '@/components/studio/email-review';
import { ChannelBrowser, type ChannelVideo } from '@/components/studio/channel-browser';
import { ArticlePicker } from '@/components/studio/article-picker';
import { ToolRail, RAIL_ICONS } from '@/components/studio/tool-rail';
import { classifyProfileUrl } from '@/lib/studio/platform';
import { createClient as createBrowserClient } from '@/lib/supabase/browser';
import { studioErrorMessage, studioFetchJson, studioFetchOk } from '@/lib/studio/fetch-json';
import { MAX_STUDIO_CONTEXT_TEXT_CHARS, limitStudioContextText } from '@/lib/studio/text-limits';
import {
  studioAnthropicCapabilityMessage,
  type StudioRunnerHealth,
} from '@/lib/studio/runner-health';
import { stableGenerationEntityId } from '@/lib/studio/generation-materialization';
import {
  canFinalizeStudioSave,
  canonicalizeStudioPersistableGraph,
  canonicalizeStoredStudioGraph,
  canonicalizeStoredStudioGraphSignature,
} from '@/lib/studio/board-persistence';
import {
  pruneRemovedPendingDeskNodeIds,
  reconcilePendingDeskNodeIds,
  recoveredPendingDeskNodeIds,
} from '@/lib/studio/desk-save-readiness';
import {
  createStudioOutputPoller,
  mergeStudioOutputLiveData,
  reconcileStudioOutputItems,
  studioOutputReferenceBatches,
  studioOutputReferenceKey,
  type StudioOutputPoller,
} from '@/lib/studio/output-polling';

type DbNode = {
  id: string;
  kind: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  source_id: string | null;
  desk_id: string | null;
};
type DbEdge = { id: string; from_node: string; to_node: string };

const uid = () => crypto.randomUUID();

const safeGenerationFailure = (status: string, error: string | null) => {
  if (status === 'submission_unknown') {
    return 'The image request may have reached fal, but its recovery receipt was lost. Studio stopped instead of risking a second charge. Ask your setup agent to review this job.';
  }
  const structured = error?.match(/^STUDIO:[^:]+:([\s\S]*)$/)?.[1]?.trim();
  return structured || error || 'The image could not be generated.';
};

// Wire with a delete affordance: hover (or select) an edge and it lights up
// with an × mid-wire (the Poppy move) — no hunting for the Backspace key.
function DeletableEdge(props: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath(props);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Grace period bridges the gap between leaving the wire and reaching the ×.
  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHovered(true);
  };
  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHovered(false), 200);
  };
  const lit = props.selected || hovered;
  const style = lit ? { ...props.style, stroke: 'var(--color-minimal-accent)', strokeWidth: 2 } : props.style;
  return (
    <>
      <BaseEdge id={props.id} path={path} style={style} markerEnd={props.markerEnd} />
      {/* Invisible wide hit-area — a 1.5px dashed line is unhoverable on its own. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ pointerEvents: 'stroke' }}
        onMouseEnter={show}
        onMouseLeave={hide}
      />
      {lit && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete this wire"
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-red-500/60 bg-minimal-bg text-[11px] leading-none text-red-500 shadow hover:bg-red-500 hover:text-white"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={show}
            onMouseLeave={hide}
            onClick={() => deleteElements({ edges: [{ id: props.id }] })}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const EDGE_TYPES = { deletable: DeletableEdge };

/**
 * Exactly what PUT /api/studio/boards/:id stores, and nothing more. This is
 * both the save payload and the definition of "dirty": selection, live output
 * status, and refreshed source data churn the React Flow arrays constantly,
 * but only changes visible HERE are worth a save.
 */
function persistableGraph(ns: Node[], es: Edge[]) {
  return canonicalizeStudioPersistableGraph({
    nodes: ns.map((n) => ({
      id: n.id,
      kind: n.type === 'cluster' ? 'group' : n.type === 'mirror' ? 'output' : n.type,
      position: n.position,
      data:
        n.type === 'note' || n.type === 'sop'
          ? { text: (n.data.text as string) ?? '', w: n.width ?? n.measured?.width, h: n.height ?? n.measured?.height }
          : n.type === 'cluster'
            ? { label: (n.data.label as string) ?? '', ...(n.data.auto ? { auto: n.data.auto } : {}) }
            : n.type === 'mirror'
              ? { output_type: n.data.output_type, ref_id: n.data.ref_id, title: n.data.title }
              : n.type === 'creative'
                ? {
                    image_url: n.data.image_url,
                    prompt: n.data.prompt,
                    gen_job_id: n.data.gen_job_id,
                    idx: n.data.idx,
                    failed: n.data.failed,
                    width: n.data.width,
                    height: n.data.height,
                    asset_type: n.data.asset_type,
                    image_size: n.data.image_size,
                  }
                : {},
      source_id: (n.data.source_id as string) ?? null,
      desk_id: (n.data.desk_id as string) ?? null,
    })),
    edges: es.map((e) => ({ id: e.id, from_node: e.source, to_node: e.target })),
  });
}

type PersistableGraph = ReturnType<typeof persistableGraph>;
type RecoverySnapshot = {
  version: 1;
  boardId: string;
  baseSig: string;
  graph: PersistableGraph;
  sources: Record<string, SourceInfo>;
  desks: Record<string, DeskInfo>;
  updatedAt: string;
};

const recoveryKey = (boardId: string) => `studio-board-recovery:${boardId}`;

const readRecovery = (boardId: string): RecoverySnapshot | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(recoveryKey(boardId)) ?? 'null') as RecoverySnapshot | null;
    if (!parsed || parsed.version !== 1 || parsed.boardId !== boardId || !parsed.graph) return null;
    const graph = canonicalizeStoredStudioGraph(parsed.graph) as PersistableGraph | null;
    const baseSig = canonicalizeStoredStudioGraphSignature(parsed.baseSig);
    if (!graph || !baseSig) return null;
    return { ...parsed, graph, baseSig };
  } catch {
    return null;
  }
};

const clearRecovery = (boardId: string) => {
  try {
    localStorage.removeItem(recoveryKey(boardId));
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
};

// Board entry should feel like an overview, even when a compact layout could
// technically fill the screen at 2x. Manual zoom remains available afterwards.
const BOARD_FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 0.9 } as const;

// React Flow defaults its controls to a light surface. Point the component's
// own theme variables at the Studio tokens so app-level light/dark switching
// updates the buttons, icons, dividers and hover state without JS theme state.
const STUDIO_CONTROL_THEME = {
  '--xy-controls-button-background-color': 'var(--color-minimal-row)',
  '--xy-controls-button-background-color-hover': 'var(--color-minimal-border)',
  '--xy-controls-button-color': 'var(--color-minimal-accent)',
  '--xy-controls-button-color-hover': 'var(--color-minimal-accent)',
  '--xy-controls-button-border-color': 'var(--color-minimal-border)',
  '--xy-controls-box-shadow': '0 0 0 1px var(--color-minimal-border)',
} as CSSProperties;

// Approximate footprints for collision-aware placement.
const NODE_DIMS: Record<string, { w: number; h: number }> = {
  source: { w: 256, h: 330 },
  desk: { w: 256, h: 210 },
  note: { w: 320, h: 210 },
  sop: { w: 288, h: 180 },
  cluster: { w: 256, h: 130 },
  mirror: { w: 240, h: 140 },
  creative: { w: 256, h: 340 },
};
const nodeDims = (n: Node) => ({
  w: n.measured?.width ?? n.width ?? NODE_DIMS[n.type ?? 'note']?.w ?? 280,
  h: n.measured?.height ?? n.height ?? NODE_DIMS[n.type ?? 'note']?.h ?? 180,
});

/** Find a spot near `desired` that doesn't overlap any existing card. */
function findFreeSpot(ns: Node[], desired: { x: number; y: number }, w: number, h: number) {
  const GAP = 28;
  const overlaps = (x: number, y: number) =>
    ns.some((n) => {
      const d = nodeDims(n);
      return (
        x < n.position.x + d.w + GAP &&
        x + w + GAP > n.position.x &&
        y < n.position.y + d.h + GAP &&
        y + h + GAP > n.position.y
      );
    });
  if (!overlaps(desired.x, desired.y)) return desired;
  for (let step = 1; step <= 40; step++) {
    for (const c of [
      { x: desired.x, y: desired.y + step * 70 },
      { x: desired.x + step * 70, y: desired.y },
      { x: desired.x, y: desired.y - step * 70 },
      { x: desired.x + step * 70, y: desired.y + step * 70 },
      { x: desired.x - step * 70, y: desired.y + step * 70 },
    ]) {
      if (!overlaps(c.x, c.y)) return c;
    }
  }
  return { x: desired.x + 200, y: desired.y + 2400 };
}

export default function StudioBoard({ boardId }: { boardId: string }) {
  const [boardName, setBoardName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [sources, setSources] = useState<Record<string, SourceInfo>>({});
  const [desks, setDesks] = useState<Record<string, DeskInfo>>({});
  const [openDesk, setOpenDesk] = useState<{ deskId: string; nodeId: string; kickoff?: string } | null>(null);
  const [pendingDeskNodeIds, setPendingDeskNodeIds] = useState<Set<string>>(() => new Set());
  const [busyDesks, setBusyDesks] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState<'source' | null>(null);
  const [askValue, setAskValue] = useState('');
  const [reviewBatch, setReviewBatch] = useState<{ type: 'email_batch' | 'broadcast'; id: string } | null>(null);
  const [channelBrowse, setChannelBrowse] = useState<string | null>(null);
  const [articlesOpen, setArticlesOpen] = useState(false);
  const [showMap, setShowMap] = useState(() =>
    typeof window === 'undefined' ? true : localStorage.getItem('studio-minimap') !== 'off'
  );
  const [saveState, setSaveState] = useState<'loading' | 'saved' | 'saving' | 'dirty'>('loading');
  const [graphVersion, setGraphVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [runnerHealth, setRunnerHealth] = useState<StudioRunnerHealth | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const flowWrapRef = useRef<HTMLDivElement | null>(null);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const lastSavedSig = useRef<string | null>(null);
  const boardRevision = useRef<number | null>(null);
  const latestGraph = useRef<{ boardId: string; graph: PersistableGraph; sig: string } | null>(null);
  const recoveryBaseSig = useRef<string | null>(null);
  const saveLoop = useRef<Promise<boolean> | null>(null);
  const saveAgain = useRef(false);
  const persistLatestRef = useRef<(() => Promise<boolean>) | null>(null);
  const outputPollerRef = useRef<StudioOutputPoller | null>(null);
  // Stable across response-loss retries inside this board session. A second
  // browser necessarily presents another operation id and the database RPC
  // returns a conflict after the first human decision wins.
  const carouselDecisionOperationIds = useRef(new Map<string, string>());
  const retryingSources = useRef(new Set<string>());
  const genMaterializePending = useRef(new Map<string, number>());
  // A terminal poll can already be in flight when the member deletes a
  // generated card. Record that decision synchronously, before the dismissal
  // PATCH crosses the network, so the stale poll response cannot resurrect it.
  const locallyDismissedGenJobs = useRef(new Set<string>());
  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const result = await studioFetchJson<{ runner?: StudioRunnerHealth }>('/api/studio/runner/health');
        if (alive) setRunnerHealth(result.runner ?? null);
      } catch {
        // Health is a diagnostic hint, never a second board-loading gate.
      }
    };
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const runnerIssue = runnerHealth?.status === 'blocked'
    ? runnerHealth.message || 'Studio’s local runner needs setup.'
    : null;
  const nonCarouselRunnerIssue = runnerHealth?.failure_code === 'carousel_toolchain_unavailable'
    ? null
    : runnerIssue;
  const imageGenerationIssue = nonCarouselRunnerIssue
    ?? (runnerHealth?.status === 'ready' && runnerHealth.capabilities?.fal_ready === false
      ? runnerHealth.capabilities.fal_configured
        ? 'The fal key could not be verified. Ask your setup agent to reconnect fal; every other Studio tool still works.'
        : 'Image generation is not connected. Ask your setup agent to connect fal; every other Studio tool still works.'
      : null);
  const carouselGenerationIssue = runnerIssue
    ?? (!runnerHealth
      ? 'Checking the local HOUSE renderer…'
      : runnerHealth.status !== 'ready'
        ? 'The local Studio runner is not currently checking in. Ask your setup agent to bring it online.'
        : runnerHealth.capabilities?.carousel_ready !== true
          ? 'The local Studio runner has not verified Chrome and every signed carousel template, font, and image. Ask your setup agent to rerun Studio runner setup.'
          : runnerHealth.capabilities?.anthropic_status !== 'valid'
          ? studioAnthropicCapabilityMessage(runnerHealth.capabilities?.anthropic_status)
            : null);

  const retrySource = useCallback(
    async (source: SourceInfo) => {
      if (retryingSources.current.has(source.id)) return;
      retryingSources.current.add(source.id);
      setSources((prev) => ({
        ...prev,
        [source.id]: {
          ...source,
          status: 'pending',
          job: { stage: 'Retrying — waiting for the Studio runner', progress: 2, status: 'queued' },
        },
      }));
      try {
        const retried = await studioFetchJson<{ source: SourceInfo; queued?: boolean }>('/api/studio/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: source.url, kind: source.kind }),
        });
        setSources((prev) => ({ ...prev, [source.id]: retried.source }));
        flash(retried.queued ? 'Retry queued — the source card will update here' : 'This source is already being processed');
      } catch (error) {
        setSources((prev) => ({ ...prev, [source.id]: source }));
        flash(studioErrorMessage(error, 'Could not retry that source.'));
      } finally {
        retryingSources.current.delete(source.id);
      }
    },
    [flash]
  );

  // ── data → React Flow mapping ─────────────────────────────────────────────
  const textChange = useCallback(
    (nodeId: string, key: 'text' | 'label') => (value: string) => {
      if (key === 'text' && value.length > MAX_STUDIO_CONTEXT_TEXT_CHARS) {
        flash(`Notes and instructions can contain up to ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} characters.`);
        return;
      }
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, [key]: value } } : n)));
    },
    [flash, setNodes]
  );

  const toFlowNode = useCallback(
    (n: DbNode, sourceMap: Record<string, SourceInfo>, deskMap: Record<string, DeskInfo>): Node => {
      // DB kind 'group' renders as canvas type 'cluster' (React Flow reserves 'group').
      const base = {
        id: n.id,
        type: n.kind === 'group' ? 'cluster' : n.kind === 'output' ? 'mirror' : n.kind,
        position: n.position,
        data: {} as Record<string, unknown>,
      };
      if (n.kind === 'source')
        base.data = {
          source: n.source_id ? sourceMap[n.source_id] : undefined,
          source_id: n.source_id,
          onRetry: retrySource,
        };
      else if (n.kind === 'note' || n.kind === 'sop') {
        base.data = { text: (n.data.text as string) ?? '', onChange: textChange(n.id, 'text') };
        (base as Node).width = (n.data.w as number) ?? 288;
        (base as Node).height = (n.data.h as number) ?? 170;
      }
      else if (n.kind === 'group')
        base.data = {
          label: (n.data.label as string) ?? '',
          auto: n.data.auto as string | undefined,
          onChange: textChange(n.id, 'label'),
        };
      else if (n.kind === 'desk')
        base.data = {
          desk: n.desk_id ? deskMap[n.desk_id] : undefined,
          desk_id: n.desk_id,
          onOpen: () => setOpenDesk({ deskId: n.desk_id!, nodeId: n.id }),
        };
      else if (n.kind === 'output' || n.kind === 'creative') base.data = { ...n.data };
      return base;
    },
    [retrySource, textChange]
  );

  // ── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let loadFrame: number | null = null;
    loaded.current = false;
    boardRevision.current = null;
    studioFetchJson<{
      board?: { name: string; graph_revision: number };
      sources?: SourceInfo[];
      desks?: DeskInfo[];
      nodes?: DbNode[];
      edges?: DbEdge[];
    }>(`/api/studio/boards/${boardId}`)
      .then((j) => {
        if (!alive || !j.board) return;
        if (!Number.isSafeInteger(j.board.graph_revision) || j.board.graph_revision < 0) {
          throw new Error('Studio atomic saves are not installed. Apply the complete 1.6.3 database migration, then reopen this board.');
        }
        setBoardName(j.board.name);
        boardRevision.current = j.board.graph_revision;
        let sourceMap: Record<string, SourceInfo> = {};
        for (const s of j.sources ?? []) sourceMap[s.id] = s;
        let deskMap: Record<string, DeskInfo> = {};
        for (const d of j.desks ?? []) deskMap[d.id] = d;
        const serverNodes = (j.nodes ?? []).map((n: DbNode) => toFlowNode(n, sourceMap, deskMap));
        const serverEdges = (j.edges ?? []).map((e: DbEdge) => ({
          id: e.id,
          source: e.from_node,
          target: e.to_node,
          type: 'deletable', style: { strokeDasharray: '6 4' },
        }));
        const serverGraph = persistableGraph(serverNodes, serverEdges);
        const serverSig = JSON.stringify(serverGraph);
        let flowNodes = serverNodes;
        let flowEdges = serverEdges;
        let selectedGraph = serverGraph;
        let selectedSig = serverSig;
        let restoredRecovery = false;
        const recovery = readRecovery(boardId);

        // Restore only when the server is still at the exact base this browser
        // edited. A different base means another tab/device changed the board;
        // never overwrite that newer state automatically.
        if (recovery) {
          const recoveredSig = JSON.stringify(recovery.graph);
          if (recovery.baseSig === serverSig && recoveredSig !== serverSig) {
            sourceMap = { ...sourceMap, ...recovery.sources };
            deskMap = { ...deskMap, ...recovery.desks };
            flowNodes = recovery.graph.nodes.map((n) => toFlowNode(n as DbNode, sourceMap, deskMap));
            flowEdges = recovery.graph.edges.map((e) => ({
              id: e.id,
              source: e.from_node,
              target: e.to_node,
              type: 'deletable', style: { strokeDasharray: '6 4' },
            }));
            selectedGraph = persistableGraph(flowNodes, flowEdges);
            selectedSig = JSON.stringify(selectedGraph);
            restoredRecovery = true;
            flash('Recovered unsaved board changes from this browser. Saving them now…');
          } else if (recoveredSig === serverSig) {
            clearRecovery(boardId);
          } else if (recovery.baseSig !== serverSig) {
            flash('This board changed elsewhere. The latest saved version is open; the older browser recovery was not applied.');
          }
        }

        setSources(sourceMap);
        setDesks(deskMap);
        setNodes(flowNodes);
        setEdges(flowEdges);
        setPendingDeskNodeIds(recoveredPendingDeskNodeIds(serverGraph.nodes, selectedGraph.nodes));
        // The server signature remains the save base even when a local
        // recovery is selected, so the recovered graph is saved immediately.
        lastSavedSig.current = serverSig;
        recoveryBaseSig.current = serverSig;
        latestGraph.current = { boardId, graph: selectedGraph, sig: selectedSig };
        setSaveState(selectedSig === serverSig ? 'saved' : 'dirty');
        setLoadState('ready');
        loadFrame = requestAnimationFrame(() => {
          if (!alive) return;
          loaded.current = true;
          // A ref flip cannot retrigger the autosave effect. Recovery is a
          // special load path, so explicitly enter the serialized save loop;
          // the browser copy stays in place until the server confirms this
          // board and exact graph.
          if (restoredRecovery) void persistLatestRef.current?.();
        });
      })
      .catch((e) => {
        if (!alive) return;
        const message = studioErrorMessage(e, 'Could not open this Studio board.');
        setLoadError(message);
        setLoadState('error');
        setSaveState('loading');
      });
    return () => {
      alive = false;
      if (loadFrame !== null) cancelAnimationFrame(loadFrame);
    };
  }, [boardId, flash, loadAttempt, setNodes, setEdges, toFlowNode]);

  // Keep source data on nodes fresh (runner status changes, busy glow).
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) =>
        n.type === 'source' && n.data.source_id
          ? { ...n, data: { ...n.data, source: sources[n.data.source_id as string] } }
          : n.type === 'desk' && n.data.desk_id
            ? {
                ...n,
                data: {
                  ...n.data,
                  desk: desks[n.data.desk_id as string],
                  busy: busyDesks.has(n.data.desk_id as string),
                },
              }
            : n
      )
    );
  }, [sources, desks, busyDesks, setNodes]);

  // Keep each group's member count fresh so the card reads as full, not empty.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.type !== 'cluster') return n;
        const memberCount = edges.filter((e) => e.target === n.id).length;
        if (n.data.memberCount === memberCount) return n;
        return { ...n, data: { ...n.data, memberCount } };
      })
    );
  }, [edges, setNodes]);

  // ── autosave ──────────────────────────────────────────────────────────────
  const writeRecovery = useCallback(
    (graph: PersistableGraph, baseSig: string) => {
      try {
        const canonicalGraph = canonicalizeStudioPersistableGraph(graph);
        const canonicalBaseSig = canonicalizeStoredStudioGraphSignature(baseSig);
        if (!canonicalBaseSig) return;
        const snapshot: RecoverySnapshot = {
          version: 1,
          boardId,
          baseSig: canonicalBaseSig,
          graph: canonicalGraph,
          sources,
          desks,
          updatedAt: new Date().toISOString(),
        };
        localStorage.setItem(recoveryKey(boardId), JSON.stringify(snapshot));
      } catch {
        // Autosave still works when browser storage is unavailable.
      }
    },
    [boardId, sources, desks],
  );

  const acknowledgeMaterializedGenJobs = useCallback(async (graph: PersistableGraph) => {
    if (!genMaterializePending.current.size) return;
    const complete = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.kind !== 'creative') continue;
      const jobId = typeof node.data.gen_job_id === 'string' ? node.data.gen_job_id : null;
      if (!jobId || !genMaterializePending.current.has(jobId)) continue;
      if (!node.data.image_url && !node.data.failed) continue;
      complete.set(jobId, (complete.get(jobId) ?? 0) + 1);
    }
    const ids = [...genMaterializePending.current.entries()]
      .filter(([id, expected]) => (complete.get(id) ?? 0) >= expected)
      .map(([id]) => id);
    if (!ids.length) return;
    try {
      // The endpoint deliberately caps one receipt write at 100 ids. Drain all
      // saved terminal jobs now; polling may stop as soon as no active jobs
      // remain, so deferring later batches until another reopen is not enough.
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        await studioFetchJson<{ ok?: boolean }>('/api/studio/gen', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ board_id: boardId, materialized_ids: batch }),
        });
        batch.forEach((id) => genMaterializePending.current.delete(id));
      }
    } catch {
      // The saved graph is authoritative. Leaving the receipt pending makes
      // GET return it again so the next poll/reopen retries the acknowledgement.
    }
  }, [boardId]);

  /**
   * Exactly one board PUT may exist at a time. Each completed request checks
   * the newest graph again before it exits, so a slow older snapshot can never
   * arrive after and erase a newer one.
   */
  const persistLatest = useCallback((): Promise<boolean> => {
    if (saveLoop.current) {
      saveAgain.current = true;
      return saveLoop.current;
    }

    const task = (async () => {
      try {
        for (;;) {
          saveAgain.current = false;
          const snapshot = latestGraph.current;
          if (!snapshot || snapshot.boardId !== boardId) {
            throw new Error('A board change interrupted this save. Reload the board before saving again.');
          }

          if (snapshot.sig !== lastSavedSig.current) {
            const expectedRevision = boardRevision.current;
            if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
              throw new Error('This board has no atomic save revision. Reload it before saving.');
            }
            setSaveState('saving');
            const saved = await studioFetchJson<{ ok?: boolean; board_id?: string; graph_revision?: number }>(`/api/studio/boards/${boardId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...snapshot.graph,
                viewport: viewportRef.current,
                expected_revision: expectedRevision,
              }),
            });
            if (
              !saved.ok
              || saved.board_id !== boardId
              || !Number.isSafeInteger(saved.graph_revision)
              || Number(saved.graph_revision) !== Number(expectedRevision) + 1
            ) {
              throw new Error('The server did not confirm this board save. Your changes are still kept in this browser.');
            }
            boardRevision.current = Number(saved.graph_revision);
            lastSavedSig.current = snapshot.sig;
            recoveryBaseSig.current = snapshot.sig;
            setPendingDeskNodeIds((pending) => reconcilePendingDeskNodeIds(pending, snapshot.graph.nodes));
            setGraphVersion((v) => v + 1);

            const newest = latestGraph.current;
            if (newest && newest.sig !== snapshot.sig) {
              writeRecovery(newest.graph, snapshot.sig);
            }
            // Re-read the refs even when no caller explicitly set saveAgain:
            // React state can settle while the request is in flight.
            continue;
          }

          await acknowledgeMaterializedGenJobs(snapshot.graph);
          const afterReceipt = latestGraph.current;
          if (!canFinalizeStudioSave(afterReceipt, boardId, lastSavedSig.current, saveAgain.current)) {
            if (afterReceipt?.boardId === boardId && afterReceipt.sig !== lastSavedSig.current) {
              writeRecovery(afterReceipt.graph, lastSavedSig.current ?? afterReceipt.sig);
            }
            setSaveState('dirty');
            continue;
          }

          clearRecovery(boardId);
          setSaveState('saved');
          return true;
        }
      } catch (e) {
        setSaveState('dirty');
        flash(studioErrorMessage(e, 'Could not save the board. Your changes are kept in this browser.'));
        return false;
      } finally {
        saveLoop.current = null;
      }
    })();
    saveLoop.current = task;
    return task;
  }, [acknowledgeMaterializedGenJobs, boardId, flash, writeRecovery]);
  persistLatestRef.current = persistLatest;

  // Waiting on an already-active save is not by itself a barrier: a new wire
  // can arrive in the final micro-window after that save checked the queue.
  // Re-check the exact latest signature after every completion and keep
  // draining until the graph the member can see is the graph the server
  // confirmed. Only then may a desk assemble context.
  const drainLatest = useCallback(async (): Promise<boolean> => {
    for (;;) {
      const ok = await persistLatest();
      if (!ok) return false;
      const latest = latestGraph.current;
      if (!latest || (latest.boardId === boardId && latest.sig === lastSavedSig.current)) return true;
    }
  }, [boardId, persistLatest]);

  const flushBoard = useCallback(() => {
    const graph = persistableGraph(nodes, edges);
    const sig = JSON.stringify(graph);
    latestGraph.current = { boardId, graph, sig };
    if (sig !== lastSavedSig.current) {
      const baseSig = recoveryBaseSig.current ?? lastSavedSig.current ?? sig;
      writeRecovery(graph, baseSig);
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    return drainLatest();
  }, [boardId, nodes, edges, drainLatest, writeRecovery]);

  useEffect(() => {
    if (!loaded.current) return;
    // Dirty means "the PERSISTABLE graph changed" — positions, text, wiring.
    // Selection flags, live output status, measured sizes, and refreshed
    // source data all churn the node arrays without touching what the save
    // endpoint stores; comparing signatures keeps them from triggering
    // phantom save cycles (and a PUT every poll tick).
    const graph = persistableGraph(nodes, edges);
    const sig = JSON.stringify(graph);
    latestGraph.current = { boardId, graph, sig };
    if (sig === lastSavedSig.current) {
      void acknowledgeMaterializedGenJobs(graph);
      clearRecovery(boardId);
      setSaveState('saved');
      return;
    }
    const baseSig = recoveryBaseSig.current ?? lastSavedSig.current ?? sig;
    writeRecovery(graph, baseSig);
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persistLatest();
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [acknowledgeMaterializedGenJobs, boardId, nodes, edges, persistLatest, writeRecovery]);

  // ── output polling: live mirrors of calendar/carousel/social objects ──────
  const outputRefKey = useMemo(
    () =>
      studioOutputReferenceKey(
        nodes
          .filter((n) => n.type === 'mirror' && n.data.output_type && n.data.ref_id)
          .map((n) => `${n.data.output_type}:${n.data.ref_id}`),
      ),
    [nodes]
  );
  useEffect(() => {
    outputPollerRef.current = null;
    if (!outputRefKey) return;
    const poller = createStudioOutputPoller({
      isVisible: () => !document.hidden,
      poll: async (signal) => {
        const statuses: Record<string, Record<string, unknown>> = {};
        for (const batch of studioOutputReferenceBatches(outputRefKey)) {
          const result = await studioFetchJson<{ statuses?: Record<string, Record<string, unknown>> }>(
            `/api/studio/outputs?refs=${encodeURIComponent(batch)}`,
            { signal },
          );
          Object.assign(statuses, result.statuses ?? {});
        }
        return statuses;
      },
      apply: (statuses) => {
        setNodes((ns) =>
          reconcileStudioOutputItems(ns, (n) => {
            if (n.type !== 'mirror') return n;
            const live = statuses[`${n.data.output_type}:${n.data.ref_id}`];
            if (!live) return n;
            const extra =
              n.data.output_type === 'email_batch' || n.data.output_type === 'broadcast'
                ? {
                    onReview: () =>
                      setReviewBatch({
                        type: n.data.output_type as 'email_batch' | 'broadcast',
                        id: n.data.ref_id as string,
                      }),
                  }
                : n.data.output_type === 'carousel_job'
                  ? {
                      // §13 on-canvas approval: the human's yes on the board
                      // where the job was born. The route rides the approval
                      // ledger; one coalesced refresh shows the flipped status.
                      onDecide: async (decision: 'approve' | 'reject', scheduledAt?: string) => {
                        const decisionKey = `${n.data.ref_id}:${decision}`;
                        let decisionOperationId = carouselDecisionOperationIds.current.get(decisionKey);
                        if (!decisionOperationId) {
                          decisionOperationId = crypto.randomUUID();
                          carouselDecisionOperationIds.current.set(decisionKey, decisionOperationId);
                        }
                        await studioFetchOk('/api/studio/outputs', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            type: 'carousel_decision',
                            payload: {
                              job_id: n.data.ref_id,
                              decision,
                              decision_operation_id: decisionOperationId,
                              ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
                            },
                          }),
                        }).catch((e) => flash(studioErrorMessage(e, 'Could not save that decision.')));
                        outputPollerRef.current?.refresh();
                      },
                    }
                  : {};
            const data = mergeStudioOutputLiveData(n.data, live, extra);
            return data === n.data ? n : { ...n, data };
          })
        );
      },
    });
    outputPollerRef.current = poller;
    const visibilityChanged = () => poller.visibilityChanged();
    document.addEventListener('visibilitychange', visibilityChanged);
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      poller.stop();
      if (outputPollerRef.current === poller) outputPollerRef.current = null;
    };
  }, [flash, outputRefKey, setNodes]);

  // Desk panel calls this when it files real work (calendar topic, carousel
  // job): drop a live output node beside the desk, wired from it.
  const addOutputNode = useCallback(
    (output: { output_type: string; ref_id: string; title?: string }, deskNodeId: string) => {
      const nodeId = uid();
      setNodes((ns) => {
        const desk = ns.find((n) => n.id === deskNodeId);
        const desired = desk ? { x: desk.position.x + 320, y: desk.position.y } : centerPosition();
        return [...ns, { id: nodeId, type: 'mirror', position: findFreeSpot(ns, desired, 240, 140), data: { ...output } }];
      });
      setEdges((es) => [...es, { id: uid(), source: deskNodeId, target: nodeId, type: 'deletable', style: { strokeDasharray: '6 4' } }]);
    },
    [setNodes, setEdges]
  );

  // ── desk-to-desk handoff: the relay baton ─────────────────────────────────
  const handoffTargets = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'desk' && n.data.desk_id)
        .map((n) => ({
          nodeId: n.id,
          deskId: n.data.desk_id as string,
          name: desks[n.data.desk_id as string]?.name ?? 'Desk',
        })),
    [nodes, desks]
  );

  const handoff = useCallback(
    (content: string, from: { nodeId: string }, target: { deskId: string; nodeId: string; name: string }) => {
      const noteId = uid();
      const bounded = limitStudioContextText(content);
      setNodes((ns) => {
        const a = ns.find((n) => n.id === from.nodeId);
        const b = ns.find((n) => n.id === target.nodeId);
        const desired =
          a && b
            ? { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 + 60 }
            : centerPosition();
        return [
          ...ns,
          {
            id: noteId,
            type: 'note',
            position: findFreeSpot(ns, desired, 320, 210),
            width: 320,
            height: 200,
            data: { text: bounded.text, onChange: textChange(noteId, 'text') },
          },
        ];
      });
      setEdges((es) => [
        ...es,
        { id: uid(), source: from.nodeId, target: noteId, type: 'deletable', style: { strokeDasharray: '6 4' } },
        { id: uid(), source: noteId, target: target.nodeId, type: 'deletable', style: { strokeDasharray: '6 4' } },
      ]);
      setOpenDesk({
        deskId: target.deskId,
        nodeId: target.nodeId,
        kickoff: 'Fresh input was just wired in from the previous desk. Run your SOP against everything now wired.',
      });
      flash(
        bounded.truncated
          ? `Handed off to ${target.name}; the board note was limited to ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} characters`
          : `Handed off to ${target.name} — review the kickoff and send`,
      );
    },
    [flash, setNodes, setEdges, textChange]
  );

  // ── creative generation: poll fal jobs, land images on the canvas ─────────
  const [genActive, setGenActive] = useState(true); // true on load for recovery
  const genFailed = useRef(new Set<string>());
  useEffect(() => {
    // Board load owns the initial graph. Starting recovery against an empty
    // pre-load state lets the later GET overwrite reconstructed paid results.
    if (!genActive || loadState !== 'ready') return;
    let alive = true;
    const poll = async () => {
      try {
        const j = await studioFetchJson<{
          jobs?: {
            id: string; desk_node_id: string | null; prompt: string; status: string; count: number;
            stage: string; error: string | null; results: { url: string; width?: number; height?: number }[] | null;
            asset_type?: string; image_size?: unknown; dismissed?: boolean;
          }[];
        }>(`/api/studio/gen?board_id=${boardId}`);
        if (!alive || !j.jobs) return;
        const jobs = j.jobs;
        for (const job of jobs) {
          if (job.dismissed || locallyDismissedGenJobs.current.has(job.id)) {
            genMaterializePending.current.delete(job.id);
            continue;
          }
          if (job.status === 'failed' || job.status === 'submission_unknown') {
            if (!genFailed.current.has(job.id)) {
              genFailed.current.add(job.id);
              flash(`Creative generation stopped: ${safeGenerationFailure(job.status, job.error)}`);
            }
            const failure = safeGenerationFailure(job.status, job.error);
            const expected = Math.max(1, job.count || 1);
            genMaterializePending.current.set(job.id, expected);
            const existingIndexes = new Set(
              nodesRef.current
                .filter((node) => node.type === 'creative' && node.data.gen_job_id === job.id)
                .map((node) => node.data.idx)
                .filter((index): index is number => typeof index === 'number'),
            );
            const missing = job.dismissed
              ? []
              : Array.from({ length: expected }, (_, index) => index)
                  .filter((index) => !existingIndexes.has(index))
                  .map((index) => ({
                    index,
                    nodeId: stableGenerationEntityId(job.id, index, 'node'),
                    edgeId: stableGenerationEntityId(job.id, index, 'edge'),
                  }));
            const fallbackPosition = centerPosition();
            // Mark this job's pending skeletons as failed in place, and create
            // any crash-recovery cards with identities fixed before React sees
            // the pure updater.
            setNodes((ns) => {
              let changed = false;
              let next = ns.map((n) => {
                if (n.type !== 'creative' || n.data.gen_job_id !== job.id || n.data.image_url || n.data.failed) return n;
                changed = true;
                return { ...n, data: { ...n.data, failed: failure.slice(0, 240) } };
              });
              if (job.dismissed || !missing.length) return changed ? next : ns;
              const have = new Set(
                next
                  .filter((node) => node.type === 'creative' && node.data.gen_job_id === job.id)
                  .map((node) => node.data.idx),
              );
              const desk = job.desk_node_id ? next.find((n) => n.id === job.desk_node_id) : undefined;
              for (const addition of missing) {
                if (have.has(addition.index) || next.some((node) => node.id === addition.nodeId)) continue;
                changed = true;
                have.add(addition.index);
                next = [...next, {
                  id: addition.nodeId,
                  type: 'creative',
                  position: findFreeSpot(
                    next,
                    desk ? { x: desk.position.x + 340, y: desk.position.y + 160 } : fallbackPosition,
                    256,
                    340,
                  ),
                  data: {
                    gen_job_id: job.id,
                    idx: addition.index,
                    prompt: job.prompt.slice(0, 1500),
                    failed: failure.slice(0, 240),
                    asset_type: job.asset_type,
                    image_size: job.image_size,
                  },
                }];
              }
              return changed ? next : ns;
            });
            const failedDeskNodeId = job.desk_node_id;
            if (failedDeskNodeId && missing.length) {
              setEdges((es) => {
                const next = [...es];
                for (const addition of missing) {
                  if (
                    next.some((edge) => edge.id === addition.edgeId)
                    || next.some((edge) => edge.source === failedDeskNodeId && edge.target === addition.nodeId)
                  ) continue;
                  next.push({
                    id: addition.edgeId,
                    source: failedDeskNodeId,
                    target: addition.nodeId,
                    type: 'deletable',
                    style: { strokeDasharray: '6 4' },
                  });
                }
                return next.length === es.length ? es : next;
              });
            }
          }
          if (job.status === 'ready' && job.results?.length) {
            genMaterializePending.current.set(job.id, job.results.length);
            const existingIndexes = new Set(
              nodesRef.current
                .filter((node) => node.type === 'creative' && node.data.gen_job_id === job.id)
                .map((node) => node.data.idx)
                .filter((index): index is number => typeof index === 'number'),
            );
            const missing = job.dismissed
              ? []
              : job.results
                  .map((result, index) => ({
                    result,
                    index,
                    nodeId: stableGenerationEntityId(job.id, index, 'node'),
                    edgeId: stableGenerationEntityId(job.id, index, 'edge'),
                  }))
                  .filter((addition) => !existingIndexes.has(addition.index));
            const fallbackPosition = centerPosition();
            setNodes((ns) => {
              // 1) Fill this job's pending skeletons in place.
              let touched = false;
              let next = ns.map((n) => {
                if (
                  n.type === 'creative' &&
                  n.data.gen_job_id === job.id &&
                  typeof n.data.idx === 'number' &&
                  !n.data.image_url &&
                  job.results![n.data.idx as number]
                ) {
                  touched = true;
                  return {
                    ...n,
                    data: {
                      ...n.data,
                      image_url: job.results![n.data.idx as number].url,
                      width: job.results![n.data.idx as number].width,
                      height: job.results![n.data.idx as number].height,
                      asset_type: job.asset_type,
                      image_size: job.image_size,
                      failed: undefined,
                    },
                  };
                }
                return n;
              });
              // 2) Add nodes for any results that have no node at all
              //    (board reopened mid-generation) — unless the job was
              //    dismissed by the user deleting its cards.
              const have = new Set(
                next.filter((n) => n.type === 'creative' && n.data.gen_job_id === job.id).map((n) => n.data.idx)
              );
              const desk = job.desk_node_id ? next.find((n) => n.id === job.desk_node_id) : undefined;
              missing.forEach((addition) => {
                if (job.dismissed || have.has(addition.index) || next.some((node) => node.id === addition.nodeId)) return;
                touched = true;
                have.add(addition.index);
                next = [
                  ...next,
                  {
                    id: addition.nodeId,
                    type: 'creative',
                    position: findFreeSpot(
                      next,
                      desk ? { x: desk.position.x + 340, y: desk.position.y + 160 } : fallbackPosition,
                      256,
                      340
                    ),
                    data: {
                      image_url: addition.result.url,
                      prompt: job.prompt.slice(0, 1500),
                      gen_job_id: job.id,
                      idx: addition.index,
                      width: addition.result.width,
                      height: addition.result.height,
                      asset_type: job.asset_type,
                      image_size: job.image_size,
                    },
                  },
                ];
              });
              return touched ? next : ns;
            });
            const readyDeskNodeId = job.desk_node_id;
            if (readyDeskNodeId && missing.length) {
              setEdges((es) => {
                const next = [...es];
                for (const addition of missing) {
                  if (
                    next.some((edge) => edge.id === addition.edgeId)
                    || next.some((edge) => edge.source === readyDeskNodeId && edge.target === addition.nodeId)
                  ) continue;
                  next.push({
                    id: addition.edgeId,
                    source: readyDeskNodeId,
                    target: addition.nodeId,
                    type: 'deletable',
                    style: { strokeDasharray: '6 4' },
                  });
                }
                return next.length === es.length ? es : next;
              });
            }
          }
        }
        const persisted = latestGraph.current;
        if (persisted?.boardId === boardId && persisted.sig === lastSavedSig.current) {
          void acknowledgeMaterializedGenJobs(persisted.graph);
        }
        if (!jobs.some((x) => ['queued', 'claimed', 'generating'].includes(x.status))) setGenActive(false);
      } catch {
        /* transient */
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [acknowledgeMaterializedGenJobs, flash, genActive, loadState, boardId, setNodes, setEdges]);

  // ── source polling while ingesting ────────────────────────────────────────
  const hasPending = useMemo(
    () => Object.values(sources).some((s) => s.status === 'pending' || s.status === 'ingesting'),
    [sources]
  );
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => {
      studioFetchJson<{ sources?: SourceInfo[] }>('/api/studio/ingest?limit=100')
        .then((j) => {
          if (!j.sources) return;
          const refreshedSources = j.sources;
          setSources((prev) => {
            const next = { ...prev };
            for (const s of refreshedSources) if (next[s.id]) next[s.id] = s;
            return next;
          });
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [hasPending]);

  // ── actions ───────────────────────────────────────────────────────────────
  function centerPosition() {
    const v = viewportRef.current;
    if (!v) return { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 };
    return {
      x: (window.innerWidth / 2 - v.x) / v.zoom - 130 + Math.random() * 60,
      y: (window.innerHeight / 2 - v.y) / v.zoom - 60 + Math.random() * 60,
    };
  }

  const ingestUrl = useCallback(
    async (url: string, kind = 'inspiration') => {
      // Channels and profiles open the browser (pick videos → grouped add)
      // instead of ingesting the page itself.
      const profile = classifyProfileUrl(url);
      if (profile) {
        if (profile.platform === 'youtube') setChannelBrowse(profile.url);
        else flash('Instagram/TikTok profile browsing isn’t wired yet — paste an individual post or Reel URL');
        return;
      }
      try {
        const j = await studioFetchJson<{ source: SourceInfo; queued?: boolean }>('/api/studio/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, kind }),
        });
        setSources((prev) => ({ ...prev, [j.source.id]: j.source }));
        const nodeId = uid();
        setNodes((ns) => [
          ...ns,
          {
            id: nodeId,
            type: 'source',
            position: findFreeSpot(ns, centerPosition(), 256, 330),
            data: { source: j.source, source_id: j.source.id, onRetry: retrySource },
          },
        ]);
        flash(j.queued ? 'Added — fetching the transcript now' : 'Already ingested — added to the board');
      } catch (e) {
        flash(studioErrorMessage(e, 'Could not add that source.'));
      }
    },
    [flash, retrySource, setNodes]
  );

  // Channel browser pick → a labeled group with the chosen videos wired in
  // (the group IS Poppy's contained collection; wire it into any desk).
  const addChannelSelection = async (channel: { title: string }, vids: ChannelVideo[], kind: string) => {
    if (!vids.length) return;
    const clusterId = uid();
    const base = centerPosition();
    setNodes((ns) => [
      ...ns,
      {
        id: clusterId,
        type: 'cluster',
        position: findFreeSpot(ns, base, 256, 130),
        data: { label: channel.title, onChange: textChange(clusterId, 'label') },
      },
    ]);
    let added = 0;
    let failed = 0;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      let j: { source: SourceInfo };
      try {
        j = await studioFetchJson<{ source: SourceInfo }>('/api/studio/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: v.url,
            kind,
            notes: `Channel browse: ${v.views.toLocaleString()} views, ${v.outlier}× the channel median`,
          }),
        });
      } catch {
        failed++;
        continue;
      }
      added++;
      setSources((prev) => ({ ...prev, [j.source.id]: j.source }));
      const nodeId = uid();
      setNodes((ns) => [
        ...ns,
        {
          id: nodeId,
          type: 'source',
          position: { x: base.x + (i % 3) * 290, y: base.y + 180 + Math.floor(i / 3) * 380 },
          data: { source: j.source, source_id: j.source.id, onRetry: retrySource },
        },
      ]);
      setEdges((es) => [
        ...es,
        { id: uid(), source: nodeId, target: clusterId, type: 'deletable', style: { strokeDasharray: '6 4' } },
      ]);
    }
    if (!added) {
      setNodes((ns) => ns.filter((n) => n.id !== clusterId));
      flash('Nothing could be added. Your board was not changed.');
      return;
    }
    setChannelBrowse(null);
    flash(
      `${added} video${added === 1 ? '' : 's'} from ${channel.title} added${failed ? ` · ${failed} failed` : ''}` +
        ' — wire the group into a desk',
    );
  };

  // Article picker → ready own-source cards (the body IS the transcript).
  const addArticles = async (ids: string[]) => {
    let j: { sources: SourceInfo[] };
    try {
      j = await studioFetchJson<{ sources: SourceInfo[] }>('/api/studio/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    } catch (e) {
      flash(studioErrorMessage(e, 'Could not add articles.'));
      return;
    } finally {
      setArticlesOpen(false);
    }
    const base = centerPosition();
    setSources((prev) => {
      const next = { ...prev };
      for (const s of j.sources) next[s.id] = s;
      return next;
    });
    setNodes((ns) => {
      let out = ns;
      (j.sources as SourceInfo[]).forEach((s, i) => {
        // Skip sources already on this board.
        if (out.some((n) => n.type === 'source' && n.data.source_id === s.id)) return;
        out = [
          ...out,
          {
            id: uid(),
            type: 'source',
            position: { x: base.x + (i % 3) * 290, y: base.y + Math.floor(i / 3) * 360 },
            data: { source: s, source_id: s.id, onRetry: retrySource },
          },
        ];
      });
      return out;
    });
    flash(`${j.sources.length} article${j.sources.length === 1 ? '' : 's'} added — wire them into a desk`);
  };

  // Files → sources without passing file bytes through Cloudflare. The Worker
  // signs the destination, the browser uploads straight to Supabase Storage,
  // then a small completion request creates the source card. Images are ready
  // immediately; PDFs are read asynchronously by the Studio runner.
  const uploadFiles = useCallback(
    async (files: File[] | FileList, at?: { x: number; y: number }) => {
      const list = Array.from(files).slice(0, 8);
      if (!list.length) return;
      const supabase = createBrowserClient();
      let offset = 0;
      for (const file of list) {
        try {
          flash(`Uploading ${file.name}…`);
          const prepared = await studioFetchJson<{
            upload_id: string;
            upload: { bucket: string; path: string; token: string };
            media: 'image' | 'pdf';
            content_type: string;
          }>('/api/studio/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'prepare',
              filename: file.name,
              content_type: file.type,
              size: file.size,
            }),
          });

          // uploadToSignedUrl sends Blob/File bodies as multipart data, whose
          // MIME comes from the Blob itself. Bind an empty/alias browser MIME
          // to the canonical value approved by prepare and the bucket policy.
          const uploadFile = file.type === prepared.content_type
            ? file
            : new File([file], file.name, {
                type: prepared.content_type,
                lastModified: file.lastModified,
              });
          const { error: uploadError } = await supabase.storage
            .from(prepared.upload.bucket)
            .uploadToSignedUrl(prepared.upload.path, prepared.upload.token, uploadFile, {
              contentType: prepared.content_type,
              upsert: false,
            });
          if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

          const completed = await studioFetchJson<{ source: SourceInfo; media: 'image' | 'pdf' }>(
            '/api/studio/upload',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'complete',
                upload_id: prepared.upload_id,
              }),
            },
          );

          const source = completed.source;
          setSources((prev) => ({ ...prev, [source.id]: source }));
          const nodeId = uid();
          const desired = at ? { x: at.x + offset, y: at.y + offset } : centerPosition();
          offset += 48;
          setNodes((ns) => [
            ...ns,
            {
              id: nodeId,
              type: 'source',
              position: findFreeSpot(ns, desired, 256, 330),
              data: { source, source_id: source.id, onRetry: retrySource },
            },
          ]);
          flash(
            completed.media === 'image'
              ? `${file.name} added — wire it into a desk`
              : `${file.name} added — the Studio runner is reading it now`,
          );
        } catch (e) {
          flash(studioErrorMessage(e, `Upload failed: ${file.name}`));
          continue;
        }
      }
    },
    [flash, retrySource, setNodes]
  );

  /** Screen → flow coordinates for drops, via the wrapper rect + live viewport. */
  const flowPoint = (clientX: number, clientY: number) => {
    const v = viewportRef.current;
    const rect = flowWrapRef.current?.getBoundingClientRect();
    if (!v || !rect) return centerPosition();
    return { x: (clientX - rect.left - v.x) / v.zoom - 128, y: (clientY - rect.top - v.y) / v.zoom - 40 };
  };

  const addTextNode = (kind: 'note' | 'sop' | 'group') => {
    const nodeId = uid();
    setNodes((ns) => [
      ...ns,
      {
        id: nodeId,
        type: kind === 'group' ? 'cluster' : kind,
        position: findFreeSpot(ns, centerPosition(), kind === 'group' ? 256 : 288, kind === 'group' ? 130 : 170),
        ...(kind !== 'group' ? { width: 288, height: 170 } : {}),
        data:
          kind === 'group'
            ? { label: '', onChange: textChange(nodeId, 'label') }
            : { text: '', onChange: textChange(nodeId, 'text') },
      },
    ]);
  };

  // One-click desk (the Poppy friction profile): a "New desk" lands and opens
  // immediately — rename it from the panel header whenever it earns a name.
  const nextDeskName = () => {
    const names = new Set(Object.values(desks).map((d) => d.name));
    if (!names.has('New desk')) return 'New desk';
    let i = 2;
    while (names.has(`New desk ${i}`)) i++;
    return `New desk ${i}`;
  };

  const addDesk = async (name: string) => {
    if (!name.trim()) return;
    let j: { desk: DeskInfo };
    try {
      j = await studioFetchJson<{ desk: DeskInfo }>('/api/studio/desks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch (e) {
      flash(studioErrorMessage(e, 'Could not create desk.'));
      return;
    }
    setDesks((prev) => ({ ...prev, [j.desk.id]: j.desk }));
    const nodeId = uid();
    setPendingDeskNodeIds((pending) => new Set(pending).add(nodeId));
    setNodes((ns) => [
      ...ns,
      {
        id: nodeId,
        type: 'desk',
        position: findFreeSpot(ns, centerPosition(), 256, 210),
        data: { desk: j.desk, desk_id: j.desk.id, onOpen: () => setOpenDesk({ deskId: j.desk.id, nodeId }) },
      },
    ]);
    setOpenDesk({ deskId: j.desk.id, nodeId });
  };

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) => addEdge({ ...c, id: uid(), type: 'deletable', style: { strokeDasharray: '6 4' } }, es)),
    [setEdges]
  );

  // Paste anything anywhere on the canvas → ingest (the Poppy move).
  // A URL becomes a scraped source; a copied image/PDF uploads directly.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('textarea,input,[contenteditable]')) return;
      const files = e.clipboardData?.files;
      if (files?.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text')?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        ingestUrl(text);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [ingestUrl, uploadFiles]);

  // Single-key shortcuts while the canvas has focus (hover a toolbar button
  // for its key). Re-subscribed per render so handlers stay fresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('textarea,input,select,[contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); setAsking('source'); setAskValue(''); }
      else if (k === 'd') { e.preventDefault(); addDesk(nextDeskName()); }
      else if (k === 'u') { e.preventDefault(); fileInputRef.current?.click(); }
      else if (k === 'a') { e.preventDefault(); setArticlesOpen(true); }
      else if (k === 'n') { e.preventDefault(); addTextNode('note'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      <div className="flex-1 relative">
        {/* Header bar */}
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-3 px-4 py-2.5 border-b border-minimal-border bg-minimal-bg/90 backdrop-blur">
          <Link href="/studio" className="text-minimal-muted hover:text-minimal-accent text-sm">
            ←
          </Link>
          <span className="text-sm font-medium">{boardName || '…'}</span>
          <span className="text-[11px] text-minimal-muted">
            {saveState === 'loading'
              ? 'Loading…'
              : saveState === 'saved'
                ? 'Saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : 'Unsaved changes'}
          </span>
          {runnerIssue && (
            <span className="ml-auto max-w-[50%] truncate text-[11px] text-red-500" title={runnerIssue}>
              Runner needs setup: {runnerIssue}
            </span>
          )}
        </div>

        {/* The canvas toolbox: right edge (left column belongs to app nav),
            every tool explained on hover. */}
        <ToolRail
          tools={[
            {
              key: 'desk',
              label: 'New desk',
              shortcut: 'D',
              primary: true,
              icon: RAIL_ICONS.desk,
              description:
                'Your AI writer. Wire sources, notes, and instructions into it, then ask it to write — it works only from what it’s wired to.',
              onClick: () => addDesk(nextDeskName()),
            },
            {
              key: 'link',
              label: 'Add a link',
              shortcut: 'S',
              icon: RAIL_ICONS.link,
              description:
                'Paste a video, post, ad, or website — it gets transcribed and analyzed. A whole YouTube channel opens the channel browser. ⌘V anywhere works too.',
              onClick: () => {
                setAsking('source');
                setAskValue('');
              },
            },
            {
              key: 'articles',
              label: 'Your articles',
              shortcut: 'A',
              icon: RAIL_ICONS.article,
              description:
                'Pull articles from your home’s blog onto the board as ready sources — the article text is the context. Multiply one piece into carousels, reels, and emails.',
              onClick: () => setArticlesOpen(true),
            },
            {
              key: 'upload',
              label: 'Upload files',
              shortcut: 'U',
              icon: RAIL_ICONS.upload,
              description:
                'Images and PDFs — or just drop them anywhere on the canvas. Reference images flow full-res into image generation.',
              onClick: () => fileInputRef.current?.click(),
            },
            {
              key: 'note',
              label: 'Note',
              shortcut: 'N',
              icon: RAIL_ICONS.note,
              description:
                'Freeform text a desk can read — ideas, angles, drafts. Desk replies can also be filed here.',
              onClick: () => addTextNode('note'),
            },
            {
              key: 'instructions',
              label: 'Instructions',
              icon: RAIL_ICONS.instructions,
              description:
                'Standing rules a desk always follows — tone, structure, do’s and don’ts. Wire one card into several desks to share a rulebook; wired cards also show inside the desk panel.',
              onClick: () => addTextNode('sop'),
            },
            {
              key: 'collection',
              label: 'Collection',
              icon: RAIL_ICONS.collection,
              description:
                'Bundle related sources, then wire the collection into a desk as one — instead of dragging ten wires.',
              onClick: () => addTextNode('group'),
            },
          ]}
        />

        {toast && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-20 rounded border border-minimal-border bg-minimal-row px-3 py-1.5 text-[12px]">
            {toast}
          </div>
        )}

        {asking && (
          <div className="absolute top-14 right-16 z-30 w-96 rounded-lg border border-minimal-border bg-minimal-row shadow-xl p-3">
            <div className="text-[12px] text-minimal-muted mb-2">
              Paste a URL — a video or post, a whole YouTube channel (opens the channel browser), a Facebook ad, or any website. (Tip: ⌘V anywhere on the canvas does this too, and files can be dropped straight onto the board.)
            </div>
            <input
              autoFocus
              className="w-full rounded border border-minimal-border bg-minimal-bg p-2 text-[13px] focus:outline-none focus:border-white/40"
              placeholder="https://…"
              value={askValue}
              onChange={(e) => setAskValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && askValue.trim()) {
                  ingestUrl(askValue.trim());
                  setAsking(null);
                }
                if (e.key === 'Escape') setAsking(null);
              }}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  if (!askValue.trim()) return;
                  ingestUrl(askValue.trim());
                  setAsking(null);
                }}
                disabled={!askValue.trim()}
                className="flex-1 rounded bg-minimal-accent text-minimal-bg text-[12px] py-1.5 font-medium disabled:opacity-40"
              >
                Add source
              </button>
              <button onClick={() => setAsking(null)} className="rounded border border-minimal-border px-3 text-[12px]">
                Cancel
              </button>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div
          ref={flowWrapRef}
          className="absolute inset-x-0 top-12 bottom-0"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as HTMLElement | null)) setDragOver(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragOver(false);
            uploadFiles(e.dataTransfer.files, flowPoint(e.clientX, e.clientY));
          }}
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 pointer-events-none border-2 border-dashed border-minimal-accent/60 bg-minimal-accent/5 flex items-center justify-center">
              <div className="rounded-lg border border-minimal-border bg-minimal-row px-4 py-2 text-[13px] shadow-xl">
                Drop to add — images or PDFs
              </div>
            </div>
          )}
          {loadState === 'loading' && (
            <div className="absolute inset-0 z-[25] flex items-center justify-center bg-minimal-bg/80 text-sm text-minimal-muted">
              Opening saved board…
            </div>
          )}
          {loadState === 'error' && (
            <div className="absolute inset-0 z-[25] flex items-center justify-center bg-minimal-bg/90">
              <div className="w-full max-w-md mx-4 rounded-xl border border-red-500/30 bg-minimal-row p-5 text-center shadow-2xl">
                <div className="text-sm font-medium">This board did not load</div>
                <div className="mt-1.5 text-[12px] leading-relaxed text-minimal-muted">
                  {loadError ?? 'The Studio could not read the saved board. Nothing has been replaced.'}
                </div>
                <div className="mt-4 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLoadState('loading');
                      setLoadError(null);
                      setSaveState('loading');
                      setLoadAttempt((v) => v + 1);
                    }}
                    className="rounded bg-minimal-accent px-3 py-1.5 text-[12px] font-medium text-minimal-bg"
                  >
                    Retry
                  </button>
                  <Link href="/studio" className="rounded border border-minimal-border px-3 py-1.5 text-[12px]">
                    Back to boards
                  </Link>
                </div>
              </div>
            </div>
          )}
          {loadState === 'ready' && nodes.length === 0 && !dragOver && (
            <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
              <div className="pointer-events-auto w-full max-w-md mx-4 rounded-xl border border-minimal-border bg-minimal-row/95 backdrop-blur p-6 text-center shadow-2xl">
                <div className="text-sm font-medium mb-1.5">Start with anything</div>
                <div className="text-[12px] text-minimal-muted leading-relaxed mb-4">
                  Drop images or PDFs anywhere on the canvas — or paste a link with ⌘V
                  (YouTube, Reels, TikTok, ads, websites). Wire sources into a desk, and the desk
                  writes from exactly what it&apos;s wired to.
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={() => addDesk(nextDeskName())} className="rounded bg-minimal-accent text-minimal-bg px-3 py-1.5 text-[12px] font-medium">New desk</button>
                  <button onClick={() => { setAsking('source'); setAskValue(''); }} className="rounded border border-minimal-border px-3 py-1.5 text-[12px] hover:bg-white/5">Paste a link</button>
                  <button onClick={() => setArticlesOpen(true)} className="rounded border border-minimal-border px-3 py-1.5 text-[12px] hover:bg-white/5">Your articles</button>
                  <button onClick={() => fileInputRef.current?.click()} className="rounded border border-minimal-border px-3 py-1.5 text-[12px] hover:bg-white/5">Upload files</button>
                  <button onClick={() => addTextNode('note')} className="rounded border border-minimal-border px-3 py-1.5 text-[12px] hover:bg-white/5">Note</button>
                </div>
              </div>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={(changes) => {
              // Deleting a creative card is a decision — dismiss its gen job so
              // the recovery poll never resurrects it. Dismissal is job-wide,
              // so remove every sibling skeleton/card from that job as one
              // local graph edit instead of leaving orphaned pulsing cards.
              const dismissedJobIds = new Set<string>();
              const directlyRemovedNodeIds = new Set(
                changes.filter((change) => change.type === 'remove').map((change) => change.id),
              );
              if (directlyRemovedNodeIds.size) {
                setPendingDeskNodeIds((pending) => pruneRemovedPendingDeskNodeIds(pending, directlyRemovedNodeIds));
                setOpenDesk((current) => current && directlyRemovedNodeIds.has(current.nodeId) ? null : current);
                setEdges((current) => current.filter(
                  (edge) => !directlyRemovedNodeIds.has(edge.source) && !directlyRemovedNodeIds.has(edge.target),
                ));
              }
              for (const c of changes) {
                if (c.type === 'remove') {
                  const n = nodesRef.current.find((x) => x.id === c.id);
                  const genJobId = typeof n?.data.gen_job_id === 'string' ? n.data.gen_job_id : null;
                  if (n?.type === 'creative' && genJobId) {
                    locallyDismissedGenJobs.current.add(genJobId);
                    genMaterializePending.current.delete(genJobId);
                    dismissedJobIds.add(genJobId);
                  }
                }
              }
              if (!dismissedJobIds.size) {
                onNodesChange(changes);
                return;
              }

              const expandedChanges = [...changes];
              const removedNodeIds = new Set(
                changes.filter((change) => change.type === 'remove').map((change) => change.id),
              );
              for (const node of nodesRef.current) {
                const genJobId = typeof node.data.gen_job_id === 'string' ? node.data.gen_job_id : null;
                if (
                  node.type === 'creative'
                  && genJobId
                  && dismissedJobIds.has(genJobId)
                  && !removedNodeIds.has(node.id)
                ) {
                  removedNodeIds.add(node.id);
                  expandedChanges.push({ id: node.id, type: 'remove' });
                }
              }
              setEdges((current) => current.filter(
                (edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target),
              ));
              for (const genJobId of dismissedJobIds) {
                studioFetchOk('/api/studio/gen', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: genJobId, dismissed: true }),
                }).catch(() => {
                  // Do not pretend a local-only tombstone is durable. Let
                  // recovery retry visibly if the server could not record
                  // the decision.
                  locallyDismissedGenJobs.current.delete(genJobId);
                  setGenActive(true);
                  flash('Could not dismiss that generated set. Studio will retry recovery.');
                });
              }
              onNodesChange(expandedChanges);
            }}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onMove={(_, viewport) => {
              viewportRef.current = viewport;
            }}
            fitView
            fitViewOptions={BOARD_FIT_VIEW_OPTIONS}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
            className="!bg-minimal-bg"
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#262626" />
            <Controls
              position="bottom-left"
              showInteractive={false}
              fitViewOptions={BOARD_FIT_VIEW_OPTIONS}
              style={STUDIO_CONTROL_THEME}
            />
            {showMap && (
              <MiniMap pannable zoomable className="!bg-minimal-row" maskColor="rgba(0,0,0,0.7)" nodeColor="#404040" />
            )}
          </ReactFlow>
        </div>

        {/* Minimap's own minimize control — lives on the map, not the toolbar */}
        {showMap ? (
          <button
            onClick={() => {
              setShowMap(false);
              localStorage.setItem('studio-minimap', 'off');
            }}
            title="Hide minimap"
            aria-label="Hide minimap"
            className="absolute z-10 grid place-items-center w-5 h-5 rounded border border-minimal-border bg-minimal-row text-minimal-muted hover:text-minimal-accent text-[11px] leading-none"
            style={{ right: 18, bottom: 160 }}
          >
            –
          </button>
        ) : (
          <button
            onClick={() => {
              setShowMap(true);
              localStorage.setItem('studio-minimap', 'on');
            }}
            title="Show minimap"
            aria-label="Show minimap"
            className="absolute z-10 grid place-items-center w-8 h-8 rounded-lg border border-minimal-border bg-minimal-row text-minimal-muted hover:text-minimal-accent"
            style={{ right: 15, bottom: 15 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 256 256" fill="currentColor">
              <path d="M228.9,49.7 156,25.4a8,8,0,0,0-5,0L100,42.4,53.1,26.8A8,8,0,0,0,40,34.4v144a8,8,0,0,0,5.1,7.5l72.9,24.3a8,8,0,0,0,5,0l51-17,46.9,15.6A8,8,0,0,0,232,201.6v-144A8,8,0,0,0,228.9,49.7ZM108,58.2l40-13.3V197.8l-40,13.3Z" />
            </svg>
          </button>
        )}
      </div>

      {reviewBatch && <EmailReview refType={reviewBatch.type} refId={reviewBatch.id} onClose={() => setReviewBatch(null)} />}

      {channelBrowse && (
        <ChannelBrowser url={channelBrowse} onClose={() => setChannelBrowse(null)} onAdd={addChannelSelection} />
      )}

      {articlesOpen && <ArticlePicker onClose={() => setArticlesOpen(false)} onAdd={addArticles} />}

      {openDesk && (
        <DeskPanel
          key={openDesk.deskId}
          deskId={openDesk.deskId}
          boardId={boardId}
          nodeId={openDesk.nodeId}
          graphVersion={graphVersion}
          contextReady={!pendingDeskNodeIds.has(openDesk.nodeId)}
          beforeSend={flushBoard}
          initialInput={openDesk.kickoff}
          onBusyChange={(b) => {
            const deskId = openDesk.deskId;
            setBusyDesks((prev) => {
              const s = new Set(prev);
              if (b) s.add(deskId);
              else s.delete(deskId);
              return s;
            });
          }}
          onRenamed={(name) => {
            const deskId = openDesk.deskId;
            setDesks((prev) => (prev[deskId] ? { ...prev, [deskId]: { ...prev[deskId], name } } : prev));
          }}
          handoffTargets={handoffTargets.filter((t) => t.deskId !== openDesk.deskId)}
          onHandoff={(content, target) => handoff(content, { nodeId: openDesk.nodeId }, target)}
          onClose={() => setOpenDesk(null)}
          onOutputCreated={(output) => {
            addOutputNode(output, openDesk.nodeId);
            flash(
              output.output_type === 'carousel_job'
                ? 'Carousel job queued — watch the node'
                : output.output_type === 'email_batch' || output.output_type === 'broadcast'
                  ? 'Broadcast staged — hit Review & approve on the node when ready'
                  : 'Calendar topic filed — watch the node'
            );
          }}
          onReplied={(text) => {
            const deskId = openDesk.deskId;
            setDesks((prev) =>
              prev[deskId]
                ? { ...prev, [deskId]: { ...prev[deskId], preview: text.replace(/[#*_`>]/g, '').slice(0, 180) } }
                : prev
            );
          }}
          onGenQueued={(job) => {
            // Lovart-style: the promise of the image exists on the canvas
            // immediately — pulsing skeletons, one per requested image,
            // wired from the desk, filled in by the poll when fal finishes.
            const deskNodeId = openDesk.nodeId;
            const count = Math.max(1, Math.min(4, Math.floor((job as { count?: number }).count ?? 1)));
            const prompt = ((job as { prompt?: string }).prompt ?? '').slice(0, 1500);
            const assetType = (job as { asset_type?: string }).asset_type;
            const imageSize = (job as { image_size?: unknown }).image_size;
            const fallbackPosition = centerPosition();
            const additions = Array.from({ length: count }, (_, index) => ({
              index,
              nodeId: stableGenerationEntityId(job.id, index, 'node'),
              edgeId: stableGenerationEntityId(job.id, index, 'edge'),
            }));
            setNodes((ns) => {
              const desk = ns.find((n) => n.id === deskNodeId);
              const added: Node[] = [];
              for (const addition of additions) {
                if (
                  ns.some((node) => node.id === addition.nodeId)
                  || ns.some((node) => node.type === 'creative' && node.data.gen_job_id === job.id && node.data.idx === addition.index)
                ) continue;
                const desired = desk
                  ? { x: desk.position.x + 340, y: desk.position.y + 160 }
                  : fallbackPosition;
                added.push({
                  id: addition.nodeId,
                  type: 'creative',
                  position: findFreeSpot([...ns, ...added], desired, 256, 340),
                  data: { gen_job_id: job.id, idx: addition.index, prompt, asset_type: assetType, image_size: imageSize },
                });
              }
              return added.length ? [...ns, ...added] : ns;
            });
            setEdges((es) => {
              const next = [...es];
              for (const addition of additions) {
                if (
                  next.some((edge) => edge.id === addition.edgeId)
                  || next.some((edge) => edge.source === deskNodeId && edge.target === addition.nodeId)
                ) continue;
                next.push({
                  id: addition.edgeId,
                  source: deskNodeId,
                  target: addition.nodeId,
                  type: 'deletable',
                  style: { strokeDasharray: '6 4' },
                });
              }
              return next.length === es.length ? es : next;
            });
            setGenActive(true);
            flash('fal is rendering — watch the pulsing node');
          }}
          imageGenerationIssue={imageGenerationIssue}
          carouselGenerationIssue={carouselGenerationIssue}
          onSaveNote={(content) => {
            const nodeId = uid();
            const bounded = limitStudioContextText(content);
            setNodes((ns) => {
              const desk = ns.find((n) => n.id === openDesk.nodeId);
              const pos = findFreeSpot(
                ns,
                desk ? { x: desk.position.x + 320, y: desk.position.y - 40 } : centerPosition(),
                340,
                260
              );
              return [
                ...ns,
                {
                  id: nodeId,
                  type: 'note',
                  position: pos,
                  width: 340,
                  height: 260,
                  data: { text: bounded.text, onChange: textChange(nodeId, 'text') },
                },
              ];
            });
            setEdges((es) => [
              ...es,
              { id: uid(), source: openDesk.nodeId, target: nodeId, type: 'deletable', style: { strokeDasharray: '6 4' } },
            ]);
            flash(
              bounded.truncated
                ? `Saved the first ${MAX_STUDIO_CONTEXT_TEXT_CHARS.toLocaleString()} characters as a board note`
                : 'Saved as a board note — wire it into the next desk',
            );
          }}
        />
      )}
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/useAuth';
import { createAgent } from '../api/agent';
import { createGatewayActor, type CandidMemoryResult } from '../api/gateway.did';

type Tab = 'explorer' | 'knowledge' | 'persona' | 'mindspaces';
type TemporalPreset = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';
type CorpusMode = 'Naive' | 'Local' | 'Global' | 'Hybrid';

interface MemoryEntry {
  content: string;
  source: 'episodic' | 'corpus' | 'chat';
  timestamp?: string;
  topics?: string[];
}

interface Corpus {
  id: string;
  name: string;
  description: string;
}

interface Mindspace {
  id: string;
  name: string;
  description: string;
  type?: string;
}

interface Blueprint {
  id: string;
  key: string;
  name: string;
  description: string;
}

interface PersonaVersion {
  id: string;
  version: number;
  createdAt: string;
  systemPrompt?: string;
}

const TEMPORAL_QUERIES: Record<Exclude<TemporalPreset, 'custom'>, string> = {
  today: "What happened in our conversations today? Key topics, decisions, and insights from today.",
  week: "Summarize the key themes, decisions, and patterns from this week's conversations.",
  month: "What are the major topics, recurring themes, and important insights from this month?",
  year: "Provide a yearly overview of major themes, milestones, and evolution in our conversations.",
  all: "What are the most important memories, recurring patterns, and key insights across all our conversations?",
};

function extractTopics(text: string): string[] {
  const topics: string[] = [];
  const patterns = [
    /(?:topic|theme|subject|about|discussed|regarding)[:\s]+([^.,\n]+)/gi,
    /\*\*([^*]+)\*\*/g,
    /(?:^|\n)\s*[-•]\s*([^:\n]+):/gm,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const t = m[1].trim();
      if (t.length > 2 && t.length < 60 && !topics.includes(t)) topics.push(t);
    }
  }
  return topics.slice(0, 12);
}

function parseMemoryResults(json: string): MemoryEntry[] {
  try {
    const data = JSON.parse(json);
    // prepare_context response
    if (data.fetcher || data.corpus || data.chat_history) {
      const entries: MemoryEntry[] = [];
      if (data.fetcher) {
        const text = typeof data.fetcher === 'string' ? data.fetcher : JSON.stringify(data.fetcher);
        if (text.trim()) entries.push({ content: text, source: 'episodic', topics: extractTopics(text) });
      }
      if (Array.isArray(data.corpus)) {
        data.corpus.forEach((c: any) => entries.push({ content: c.content || c, source: 'corpus' }));
      }
      if (Array.isArray(data.chat_history)) {
        data.chat_history.slice(-10).forEach((m: any) =>
          entries.push({ content: m.content, source: 'chat', timestamp: m.create_at || m.createdAt })
        );
      }
      return entries;
    }
    // Array of results
    if (Array.isArray(data)) {
      return data.map((d: any) => ({
        content: d.content || JSON.stringify(d),
        source: d.source || 'episodic',
        timestamp: d.timestamp || d.create_at,
        topics: d.topics,
      }));
    }
    return [{ content: json, source: 'episodic', topics: extractTopics(json) }];
  } catch {
    return [{ content: json, source: 'episodic', topics: extractTopics(json) }];
  }
}

function unwrapResult(res: CandidMemoryResult): { ok: boolean; data: string } {
  if ('Success' in res) return { ok: true, data: res.Success };
  if ('Failed' in res) return { ok: false, data: res.Failed };
  if ('NotConfigured' in res) return { ok: false, data: res.NotConfigured };
  return { ok: false, data: 'Unknown result' };
}

export default function MemoryPage() {
  const { authClient } = useAuth();
  const [tab, setTab] = useState<Tab>('explorer');
  // Explorer state
  const [preset, setPreset] = useState<TemporalPreset>('today');
  const [customQuery, setCustomQuery] = useState('');
  const [explorerResults, setExplorerResults] = useState<MemoryEntry[]>([]);
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [mindspaceId, setMindspaceId] = useState('default');
  // Knowledge state
  const [corpora, setCorpora] = useState<Corpus[]>([]);
  const [selectedCorpus, setSelectedCorpus] = useState<string>('');
  const [corpusName, setCorpusName] = useState('');
  const [corpusDesc, setCorpusDesc] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<CorpusMode>('Hybrid');
  const [searchResults, setSearchResults] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  // Persona Intelligence state
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [traits, setTraits] = useState<any[]>([]);
  const [hydratedBlueprint, setHydratedBlueprint] = useState('');
  const [effectivePersonality, setEffectivePersonality] = useState('');
  const [personaVersions, setPersonaVersions] = useState<PersonaVersion[]>([]);
  const [personaIdInput, setPersonaIdInput] = useState('');
  const [bpName, setBpName] = useState('');
  const [bpDesc, setBpDesc] = useState('');
  const [selectedBlueprintId, setSelectedBlueprintId] = useState('');
  // Mindspace state
  const [mindspaces, setMindspaces] = useState<Mindspace[]>([]);
  const [msName, setMsName] = useState('');
  const [msDesc, setMsDesc] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [msgCursor, setMsgCursor] = useState<string | null>(null);
  const [msgHasMore, setMsgHasMore] = useState(false);
  const [msgMindspace, setMsgMindspace] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [participantMs, setParticipantMs] = useState('');
  // General
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const getGateway = useCallback(async () => {
    const agent = await createAgent(authClient ?? undefined);
    return createGatewayActor(agent);
  }, [authClient]);

  const loadCorpora = useCallback(async () => {
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.listCorpora());
      if (res.ok) {
        try { setCorpora(JSON.parse(res.data)); } catch { setCorpora([]); }
      }
    } catch {}
  }, [getGateway]);

  const loadMindspaces = useCallback(async () => {
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.listMindspaces());
      if (res.ok) {
        try { setMindspaces(JSON.parse(res.data)); } catch { setMindspaces([]); }
      }
    } catch {}
  }, [getGateway]);

  useEffect(() => { loadCorpora(); loadMindspaces(); }, [loadCorpora, loadMindspaces]);

  // ── Explorer ───────────────────────────────────
  const runExplorer = async (p: TemporalPreset) => {
    setPreset(p);
    setExplorerLoading(true);
    setError('');
    try {
      const gw = await getGateway();
      const q = p === 'custom' ? customQuery : TEMPORAL_QUERIES[p];
      const res = unwrapResult(await gw.prepareContext(mindspaceId, BigInt(50), [], [q]));
      if (res.ok) {
        setExplorerResults(parseMemoryResults(res.data));
      } else {
        setError(res.data);
        setExplorerResults([]);
      }
    } catch (e: any) { setError(e.message || 'Failed'); }
    setExplorerLoading(false);
  };

  // ── Knowledge Bases ────────────────────────────
  const handleCreateCorpus = async () => {
    if (!corpusName.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.createCorpus(corpusName, corpusDesc));
      if (res.ok) { setCorpusName(''); setCorpusDesc(''); await loadCorpora(); }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleDeleteCorpus = async (id: string) => {
    setLoading(true);
    try {
      const gw = await getGateway();
      await gw.deleteCorpus(id);
      await loadCorpora();
      if (selectedCorpus === id) setSelectedCorpus('');
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleSearchCorpus = async () => {
    if (!selectedCorpus || !searchQuery.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.queryCorpus(selectedCorpus, searchQuery, searchMode, true));
      setSearchResults(res.ok ? res.data : res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleFileUpload = async () => {
    if (!uploadFile || !selectedCorpus) return;
    setUploadStatus('Getting upload URL...');
    try {
      const gw = await getGateway();
      const presignRes = unwrapResult(await gw.presignUpload(uploadFile.name, uploadFile.type || 'application/octet-stream', BigInt(uploadFile.size), [selectedCorpus]));
      if (!presignRes.ok) { setUploadStatus('Error: ' + presignRes.data); return; }
      const presign = JSON.parse(presignRes.data);
      setUploadStatus('Uploading file...');
      await fetch(presign.upload_url || presign.uploadUrl, { method: 'PUT', body: uploadFile, headers: { 'Content-Type': uploadFile.type || 'application/octet-stream' } });
      setUploadStatus('Adding to corpus...');
      const artId = presign.artifact_id || presign.artifactId;
      await gw.addArtifactToCorpus(selectedCorpus, artId);
      setUploadStatus('Ingesting... (checking status)');
      let tries = 0;
      while (tries < 30) {
        await new Promise(r => setTimeout(r, 2000));
        const statusRes = unwrapResult(await gw.getIngestionStatus(selectedCorpus, artId));
        if (statusRes.ok) {
          try {
            const s = JSON.parse(statusRes.data);
            if (s.status === 'processed') { setUploadStatus('Done! File ingested.'); setUploadFile(null); return; }
            if (s.status === 'failed') { setUploadStatus('Ingestion failed: ' + (s.error || 'unknown')); return; }
          } catch {}
        }
        tries++;
        setUploadStatus(`Ingesting... (attempt ${tries}/30)`);
      }
      setUploadStatus('Ingestion still processing. Check back later.');
    } catch (e: any) { setUploadStatus('Error: ' + e.message); }
  };

  // ── Persona Intelligence ───────────────────────
  const loadBlueprints = async () => {
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmListBlueprints());
      if (res.ok) { try { setBlueprints(JSON.parse(res.data)); } catch { setBlueprints([]); } }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const loadTraits = async () => {
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmListTraits());
      if (res.ok) { try { setTraits(JSON.parse(res.data)); } catch { setTraits([]); } }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleHydrate = async (bpId: string) => {
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmHydrateBlueprint(bpId));
      setHydratedBlueprint(res.ok ? res.data : 'Error: ' + res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleEffective = async () => {
    if (!personaIdInput.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmGetEffectivePersonality(personaIdInput));
      setEffectivePersonality(res.ok ? res.data : 'Error: ' + res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleVersions = async () => {
    if (!personaIdInput.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmListPersonaVersions(personaIdInput));
      if (res.ok) { try { setPersonaVersions(JSON.parse(res.data)); } catch { setPersonaVersions([]); } }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleCreateFromBlueprint = async () => {
    if (!selectedBlueprintId || !bpName.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmCreatePersonaFromBlueprint(selectedBlueprintId, bpName, bpDesc));
      if (res.ok) { setError(''); setBpName(''); setBpDesc(''); alert('Persona created! ' + res.data); }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleInvalidateCache = async () => {
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmInvalidateCache());
      alert(res.ok ? 'Cache invalidated!' : 'Error: ' + res.data);
    } catch (e: any) { setError(e.message); }
  };

  // ── Mindspace Messages ─────────────────────────
  const loadMessages = async (msId: string, reset = true) => {
    setLoading(true);
    try {
      const gw = await getGateway();
      const c: [] | [string] = reset ? [] : (msgCursor ? [msgCursor] : []);
      const res = unwrapResult(await gw.mmGetMessages(msId, BigInt(20), 'desc', c));
      if (res.ok) {
        try {
          const data = JSON.parse(res.data);
          const msgs = data.data || data.messages || data;
          if (reset) setMessages(Array.isArray(msgs) ? msgs : []);
          else setMessages(prev => [...prev, ...(Array.isArray(msgs) ? msgs : [])]);
          setMsgHasMore(data.paging?.has_more || data.has_more || false);
          setMsgCursor(data.paging?.cursors?.after || data.cursor || null);
        } catch { setMessages([]); }
      } else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleAddParticipant = async () => {
    if (!participantMs || !participantId.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.mmAddParticipant(participantMs, participantId, 'member'));
      if (res.ok) { alert('Participant added!'); setParticipantId(''); }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleCreateMindspace = async () => {
    if (!msName.trim()) return;
    setLoading(true);
    try {
      const gw = await getGateway();
      const res = unwrapResult(await gw.createMindspace(msName, msDesc, [], 'PRIVATE'));
      if (res.ok) { setMsName(''); setMsDesc(''); await loadMindspaces(); }
      else setError(res.data);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const sty = {
    page: { padding: '24px', maxWidth: '1200px', margin: '0 auto', color: '#e0e0e0' } as React.CSSProperties,
    tabs: { display: 'flex', gap: '4px', marginBottom: '20px', background: '#0d1117', borderRadius: '12px', padding: '4px' } as React.CSSProperties,
    tab: (active: boolean) => ({ padding: '10px 20px', borderRadius: '10px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '14px', background: active ? 'linear-gradient(135deg, #00d2ff22, #7b2ff722)' : 'transparent', color: active ? '#00d2ff' : '#888', transition: 'all 0.2s' } as React.CSSProperties),
    card: { background: '#16213e', borderRadius: '12px', padding: '16px', marginBottom: '12px', border: '1px solid #ffffff10' } as React.CSSProperties,
    input: { width: '100%', padding: '10px 14px', borderRadius: '8px', border: '1px solid #ffffff20', background: '#0d1117', color: '#e0e0e0', fontSize: '14px', outline: 'none', boxSizing: 'border-box' as const } as React.CSSProperties,
    btn: (color = '#00d2ff') => ({ padding: '8px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '13px', background: color, color: '#fff', transition: 'opacity 0.2s' } as React.CSSProperties),
    presetBtn: (active: boolean) => ({ padding: '8px 16px', borderRadius: '20px', border: active ? '2px solid #00d2ff' : '1px solid #ffffff20', cursor: 'pointer', fontWeight: 600, fontSize: '13px', background: active ? '#00d2ff15' : '#0d1117', color: active ? '#00d2ff' : '#aaa', transition: 'all 0.2s' } as React.CSSProperties),
    badge: (color: string) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: color + '22', color, marginRight: '6px' } as React.CSSProperties),
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' } as React.CSSProperties,
    section: { marginBottom: '24px' } as React.CSSProperties,
    label: { fontSize: '12px', fontWeight: 600, color: '#888', textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: '8px', display: 'block' } as React.CSSProperties,
    pre: { background: '#0d1117', padding: '12px', borderRadius: '8px', fontSize: '12px', overflow: 'auto', maxHeight: '300px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const } as React.CSSProperties,
    topicTag: { display: 'inline-block', padding: '2px 10px', borderRadius: '12px', fontSize: '11px', background: '#7b2ff722', color: '#c084fc', marginRight: '4px', marginBottom: '4px' } as React.CSSProperties,
  };

  return (
    <div style={sty.page}>
      <h2 style={{ margin: '0 0 4px', background: 'linear-gradient(90deg, #00d2ff, #7b2ff7)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Memory & Intelligence</h2>
      <p style={{ color: '#666', margin: '0 0 20px', fontSize: '14px' }}>Episodic memory, knowledge bases, persona intelligence, and mindspace management</p>

      {error && <div style={{ ...sty.card, borderColor: '#ff4444', color: '#ff6b6b', marginBottom: '16px' }}>{error} <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}>x</button></div>}

      <div style={sty.tabs}>
        {([['explorer', 'Memory Explorer'], ['knowledge', 'Knowledge Bases'], ['persona', 'Persona Intelligence'], ['mindspaces', 'Mindspaces']] as [Tab, string][]).map(([k, v]) => (
          <button key={k} style={sty.tab(tab === k)} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>

      {/* ═══ MEMORY EXPLORER ═══ */}
      {tab === 'explorer' && (
        <div>
          <div style={sty.section}>
            <span style={sty.label}>Mindspace</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input style={{ ...sty.input, maxWidth: '300px' }} value={mindspaceId} onChange={e => setMindspaceId(e.target.value)} placeholder="Mindspace ID" />
            </div>
            <span style={sty.label}>Time Range</span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
              {(['today', 'week', 'month', 'year', 'all'] as TemporalPreset[]).map(p => (
                <button key={p} style={sty.presetBtn(preset === p)} onClick={() => runExplorer(p)}>
                  {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : p === 'year' ? 'This Year' : 'All Time'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={sty.input} value={customQuery} onChange={e => setCustomQuery(e.target.value)} placeholder="Custom memory query..." onKeyDown={e => e.key === 'Enter' && runExplorer('custom')} />
              <button style={sty.btn()} onClick={() => runExplorer('custom')}>Search</button>
            </div>
          </div>

          {explorerLoading && <div style={{ textAlign: 'center', padding: '40px', color: '#888' }}>Searching memories...</div>}

          {!explorerLoading && explorerResults.length > 0 && (
            <div>
              {/* Topic tags */}
              {(() => {
                const allTopics = explorerResults.flatMap(r => r.topics || []);
                const unique = [...new Set(allTopics)];
                return unique.length > 0 ? (
                  <div style={{ marginBottom: '16px' }}>
                    <span style={sty.label}>Extracted Topics</span>
                    <div>{unique.map(t => <span key={t} style={sty.topicTag}>{t}</span>)}</div>
                  </div>
                ) : null;
              })()}

              {explorerResults.map((entry, i) => (
                <div key={i} style={sty.card}>
                  <div style={{ marginBottom: '8px' }}>
                    <span style={sty.badge(entry.source === 'episodic' ? '#c084fc' : entry.source === 'corpus' ? '#00d2ff' : '#22c55e')}>
                      {entry.source === 'episodic' ? 'Episodic' : entry.source === 'corpus' ? 'Knowledge' : 'Chat History'}
                    </span>
                    {entry.timestamp && <span style={{ fontSize: '11px', color: '#666' }}>{entry.timestamp}</span>}
                  </div>
                  <div style={{ fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{entry.content}</div>
                  {entry.topics && entry.topics.length > 0 && (
                    <div style={{ marginTop: '8px' }}>{entry.topics.map(t => <span key={t} style={sty.topicTag}>{t}</span>)}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!explorerLoading && explorerResults.length === 0 && preset && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#555' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>&#x1F9E0;</div>
              <div>Select a time range or enter a custom query to explore memories</div>
            </div>
          )}
        </div>
      )}

      {/* ═══ KNOWLEDGE BASES ═══ */}
      {tab === 'knowledge' && (
        <div>
          <div style={sty.section}>
            <span style={sty.label}>Create Knowledge Base</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <input style={{ ...sty.input, flex: 1 }} value={corpusName} onChange={e => setCorpusName(e.target.value)} placeholder="Name" />
              <input style={{ ...sty.input, flex: 2 }} value={corpusDesc} onChange={e => setCorpusDesc(e.target.value)} placeholder="Description" />
              <button style={sty.btn()} onClick={handleCreateCorpus} disabled={loading}>Create</button>
            </div>
          </div>

          <div style={sty.grid}>
            {corpora.map(c => (
              <div key={c.id} style={{ ...sty.card, cursor: 'pointer', borderColor: selectedCorpus === c.id ? '#00d2ff' : '#ffffff10' }} onClick={() => setSelectedCorpus(c.id)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{c.name}</strong>
                  <button style={{ background: 'none', border: 'none', color: '#ff4444', cursor: 'pointer', fontSize: '16px' }} onClick={e => { e.stopPropagation(); handleDeleteCorpus(c.id); }}>x</button>
                </div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>{c.description || 'No description'}</div>
                <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>ID: {c.id.slice(0, 12)}...</div>
              </div>
            ))}
          </div>

          {selectedCorpus && (
            <div style={sty.section}>
              <span style={sty.label}>Search Selected Corpus</span>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <input style={{ ...sty.input, flex: 1 }} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search query..." onKeyDown={e => e.key === 'Enter' && handleSearchCorpus()} />
                <select style={{ ...sty.input, width: '120px', flex: 'none' }} value={searchMode} onChange={e => setSearchMode(e.target.value as CorpusMode)}>
                  <option value="Naive">Naive</option><option value="Local">Local</option><option value="Global">Global</option><option value="Hybrid">Hybrid</option>
                </select>
                <button style={sty.btn()} onClick={handleSearchCorpus} disabled={loading}>Search</button>
              </div>
              {searchResults && <pre style={sty.pre}>{searchResults}</pre>}

              <span style={sty.label}>Upload Document</span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="file" onChange={e => setUploadFile(e.target.files?.[0] || null)} style={{ fontSize: '13px' }} />
                <button style={sty.btn('#7b2ff7')} onClick={handleFileUpload} disabled={!uploadFile || loading}>Upload & Ingest</button>
              </div>
              {uploadStatus && <div style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>{uploadStatus}</div>}
            </div>
          )}
        </div>
      )}

      {/* ═══ PERSONA INTELLIGENCE ═══ */}
      {tab === 'persona' && (
        <div>
          <div style={sty.section}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <button style={sty.btn()} onClick={loadBlueprints} disabled={loading}>Load Blueprints</button>
              <button style={sty.btn('#7b2ff7')} onClick={loadTraits} disabled={loading}>Load Traits</button>
              <button style={sty.btn('#22c55e')} onClick={handleInvalidateCache}>Invalidate Cache</button>
            </div>
          </div>

          {blueprints.length > 0 && (
            <div style={sty.section}>
              <span style={sty.label}>Blueprints</span>
              <div style={sty.grid}>
                {blueprints.map(bp => (
                  <div key={bp.id} style={{ ...sty.card, cursor: 'pointer', borderColor: selectedBlueprintId === bp.id ? '#7b2ff7' : '#ffffff10' }} onClick={() => setSelectedBlueprintId(bp.id)}>
                    <strong>{bp.name}</strong>
                    <div style={{ fontSize: '12px', color: '#888', margin: '4px 0' }}>{bp.description}</div>
                    <div style={{ fontSize: '11px', color: '#555' }}>Key: {bp.key}</div>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                      <button style={sty.btn('#7b2ff7')} onClick={e => { e.stopPropagation(); handleHydrate(bp.id); }}>Hydrate</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedBlueprintId && (
            <div style={sty.section}>
              <span style={sty.label}>Create Persona from Blueprint</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input style={{ ...sty.input, flex: 1 }} value={bpName} onChange={e => setBpName(e.target.value)} placeholder="Persona name" />
                <input style={{ ...sty.input, flex: 2 }} value={bpDesc} onChange={e => setBpDesc(e.target.value)} placeholder="Description" />
                <button style={sty.btn('#22c55e')} onClick={handleCreateFromBlueprint} disabled={loading}>Create</button>
              </div>
            </div>
          )}

          {hydratedBlueprint && (
            <div style={sty.section}>
              <span style={sty.label}>Hydrated Blueprint (Full Trait Definitions)</span>
              <pre style={sty.pre}>{(() => { try { return JSON.stringify(JSON.parse(hydratedBlueprint), null, 2); } catch { return hydratedBlueprint; } })()}</pre>
            </div>
          )}

          {traits.length > 0 && (
            <div style={sty.section}>
              <span style={sty.label}>Server-Side Traits ({traits.length})</span>
              <div style={sty.grid}>
                {traits.map((t: any, i: number) => (
                  <div key={i} style={sty.card}>
                    <strong>{t.name || t.display_name}</strong>
                    <div style={{ fontSize: '12px', color: '#888', margin: '4px 0' }}>{t.description}</div>
                    <span style={sty.badge('#00d2ff')}>{t.trait_type || t.traitType}</span>
                    <span style={sty.badge('#c084fc')}>{t.category}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={sty.section}>
            <span style={sty.label}>Persona Inspector</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <input style={{ ...sty.input, flex: 1 }} value={personaIdInput} onChange={e => setPersonaIdInput(e.target.value)} placeholder="MagickMind Persona ID" />
              <button style={sty.btn()} onClick={handleEffective} disabled={loading}>Effective Personality</button>
              <button style={sty.btn('#7b2ff7')} onClick={handleVersions} disabled={loading}>Version History</button>
            </div>
          </div>

          {effectivePersonality && (
            <div style={sty.section}>
              <span style={sty.label}>Effective Personality (Runtime Blend)</span>
              <pre style={sty.pre}>{(() => { try { return JSON.stringify(JSON.parse(effectivePersonality), null, 2); } catch { return effectivePersonality; } })()}</pre>
            </div>
          )}

          {personaVersions.length > 0 && (
            <div style={sty.section}>
              <span style={sty.label}>Persona Evolution Timeline</span>
              <div style={{ position: 'relative', paddingLeft: '24px', borderLeft: '2px solid #7b2ff733' }}>
                {personaVersions.map((v, i) => (
                  <div key={v.id || i} style={{ marginBottom: '16px', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '-29px', top: '4px', width: '10px', height: '10px', borderRadius: '50%', background: i === 0 ? '#00d2ff' : '#7b2ff7' }} />
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>Version {v.version || personaVersions.length - i}</div>
                    <div style={{ fontSize: '11px', color: '#666' }}>{v.createdAt}</div>
                    {v.systemPrompt && <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px' }}>{v.systemPrompt.slice(0, 200)}...</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ MINDSPACES ═══ */}
      {tab === 'mindspaces' && (
        <div>
          <div style={sty.section}>
            <span style={sty.label}>Create Mindspace</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input style={{ ...sty.input, flex: 1 }} value={msName} onChange={e => setMsName(e.target.value)} placeholder="Name" />
              <input style={{ ...sty.input, flex: 2 }} value={msDesc} onChange={e => setMsDesc(e.target.value)} placeholder="Description" />
              <button style={sty.btn()} onClick={handleCreateMindspace} disabled={loading}>Create</button>
            </div>
          </div>

          <div style={sty.grid}>
            {mindspaces.map(ms => (
              <div key={ms.id} style={sty.card}>
                <strong>{ms.name}</strong>
                <div style={{ fontSize: '12px', color: '#888', margin: '4px 0' }}>{ms.description || 'No description'}</div>
                <div style={{ fontSize: '11px', color: '#555' }}>ID: {ms.id}</div>
                {ms.type && <span style={sty.badge('#22c55e')}>{ms.type}</span>}
                <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                  <button style={sty.btn()} onClick={() => { setMsgMindspace(ms.id); loadMessages(ms.id); }}>Messages</button>
                  <button style={sty.btn('#7b2ff7')} onClick={() => setParticipantMs(ms.id)}>Add User</button>
                </div>
              </div>
            ))}
          </div>

          {participantMs && (
            <div style={sty.section}>
              <span style={sty.label}>Add Participant to {participantMs}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input style={{ ...sty.input, flex: 1 }} value={participantId} onChange={e => setParticipantId(e.target.value)} placeholder="User ID or Principal" />
                <button style={sty.btn('#22c55e')} onClick={handleAddParticipant} disabled={loading}>Add</button>
                <button style={sty.btn('#ff4444')} onClick={() => setParticipantMs('')}>Cancel</button>
              </div>
            </div>
          )}

          {msgMindspace && (
            <div style={sty.section}>
              <span style={sty.label}>Message History -- {msgMindspace}</span>
              {messages.length === 0 && !loading && <div style={{ color: '#555', padding: '20px', textAlign: 'center' }}>No messages found</div>}
              {messages.map((m: any, i: number) => (
                <div key={i} style={{ ...sty.card, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#00d2ff' }}>{m.sent_by_user_id || m.senderId || 'Unknown'}</span>
                    <span style={{ fontSize: '11px', color: '#555' }}>{m.create_at || m.createdAt}</span>
                  </div>
                  <div style={{ fontSize: '14px' }}>{m.content}</div>
                </div>
              ))}
              {msgHasMore && (
                <button style={{ ...sty.btn(), width: '100%', marginTop: '8px' }} onClick={() => loadMessages(msgMindspace, false)} disabled={loading}>
                  Load More
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

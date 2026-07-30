import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, Input, Label, Textarea, Badge } from "@/components/ui/input";

type Author = { name: string; position?: number };

export function NewClaimPage() {
  const nav = useNavigate();
  const [doi, setDoi] = useState("");
  const [title, setTitle] = useState("");
  const [issn, setIssn] = useState("");
  const [journal, setJournal] = useState("");
  const [year, setYear] = useState("");
  const [snip, setSnip] = useState("");
  const [quartile, setQuartile] = useState("");
  const [authors, setAuthors] = useState<Author[]>([]);
  const [totalAuthors, setTotalAuthors] = useState(1);
  const [authorPosition, setAuthorPosition] = useState(1);
  const [eid, setEid] = useState("");
  const [scopusUrl, setScopusUrl] = useState("");
  const [coverDate, setCoverDate] = useState("");
  const [aggType, setAggType] = useState("");
  const [calc, setCalc] = useState<{ remuneration?: number | null; error?: string | null; base?: number | null; point?: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [matchedTitle, setMatchedTitle] = useState("");
  const [overrideDup, setOverrideDup] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const authorOptions = useMemo(() => {
    if (authors.length) return authors.map((a, i) => ({ label: a.name || `Author ${i + 1}`, value: i + 1 }));
    return Array.from({ length: totalAuthors }, (_, i) => ({ label: `Position ${i + 1}`, value: i + 1 }));
  }, [authors, totalAuthors]);

  async function enrich() {
    setBusy(true);
    setError("");
    try {
      const scopus = await api<{
        paper: Record<string, unknown> | null;
        serial: Record<string, unknown> | null;
      }>("/api/lookup/scopus", {
        method: "POST",
        json: { doi: doi || null, title: title || null, issn: issn || null },
      });
      const paper = scopus.paper;
      if (paper) {
        setMatchedTitle(String(paper.title || ""));
        setTitle(String(paper.title || title));
        setDoi(String(paper.doi || doi));
        setIssn(String(paper.issn || issn));
        setJournal(String(paper.journal_title || journal));
        if (paper.publication_year) setYear(String(paper.publication_year));
        if (paper.eid) setEid(String(paper.eid));
        if (paper.scopus_url) setScopusUrl(String(paper.scopus_url));
        if (paper.cover_date) setCoverDate(String(paper.cover_date));
        if (paper.aggregation_type) setAggType(String(paper.aggregation_type));
        const auths = (paper.authors as Author[]) || [];
        setAuthors(auths);
        if (auths.length) {
          setTotalAuthors(auths.length);
          setAuthorPosition(1);
        }
      }
      if (scopus.serial?.snip != null) setSnip(String(scopus.serial.snip));

      const scimago = await api<{
        matched_quartile?: string;
        sjr?: number;
      } | null>("/api/lookup/scimago", {
        method: "POST",
        json: { issn: paper?.issn || issn || null, title: paper?.journal_title || journal || null },
      });
      if (scimago?.matched_quartile) setQuartile(scimago.matched_quartile);

      const snipNum = scopus.serial?.snip != null ? Number(scopus.serial.snip) : snip ? Number(snip) : null;
      const q = scimago?.matched_quartile || quartile || null;
      if (q) {
        const c = await api<typeof calc>("/api/calculate", {
          method: "POST",
          json: {
            snip: snipNum,
            quartile: q,
            total_authors: authsLen(paper),
            author_position: 1,
          },
        });
        setCalc(c);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrich failed");
    } finally {
      setBusy(false);
    }
  }

  function authsLen(paper: Record<string, unknown> | null | undefined) {
    const a = (paper?.authors as Author[]) || [];
    return a.length || totalAuthors || 1;
  }

  async function recalc() {
    const c = await api<typeof calc>("/api/calculate", {
      method: "POST",
      json: {
        snip: snip === "" ? null : Number(snip),
        quartile: quartile || null,
        total_authors: totalAuthors,
        author_position: authorPosition,
      },
    });
    setCalc(c);
  }

  async function save(submit: boolean) {
    setBusy(true);
    setError("");
    try {
      const claim = await api<{ id: string }>("/api/claims", {
        method: "POST",
        json: {
          doi: doi || null,
          issn: issn || null,
          journal_title: journal || null,
          paper_title: title || null,
          publication_year: year ? Number(year) : null,
          snip: snip === "" ? null : Number(snip),
          quartile: quartile || null,
          total_authors: totalAuthors,
          author_position: authorPosition,
          authors_json: JSON.stringify(authors),
          eid: eid || null,
          scopus_url: scopusUrl || null,
          cover_date: coverDate || null,
          aggregation_type: aggType || null,
          override_duplicate: overrideDup,
          override_reason: overrideReason || null,
          submit,
        },
      });
      nav(`/claims/${claim.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await save(false);
  }

  return (
    <div>
      <div className="mb-6">
        <div className="text-xs uppercase tracking-[0.14em] text-slate-500">File</div>
        <h1 className="text-2xl font-semibold">New claim</h1>
        <p className="mt-1 text-sm text-slate-600">Enter DOI or title, enrich from Scopus, then save or submit.</p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit}>
        <Card className="space-y-4 p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="doi">DOI</Label>
              <Input id="doi" value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.xxxx/..." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issn">ISSN</Label>
              <Input id="issn" value={issn} onChange={(e) => setIssn(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">Paper title</Label>
            <Textarea id="title" value={title} onChange={(e) => setTitle(e.target.value)} required rows={3} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={enrich} disabled={busy || (!doi && !title)}>
              {busy ? "Enriching…" : "Auto enrich (Scopus + Scimago)"}
            </Button>
            {matchedTitle ? <Badge className="self-center">Matched: {matchedTitle.slice(0, 80)}</Badge> : null}
          </div>
        </Card>

        <Card className="grid gap-4 p-5 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Journal</Label>
            <Input value={journal} onChange={(e) => setJournal(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Year</Label>
            <Input value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>SNIP</Label>
            <Input value={snip} onChange={(e) => setSnip(e.target.value)} onBlur={recalc} />
          </div>
          <div className="space-y-1.5">
            <Label>Quartile</Label>
            <select
              className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              value={quartile}
              onChange={(e) => {
                setQuartile(e.target.value);
                setTimeout(recalc, 0);
              }}
            >
              <option value="">Select…</option>
              {["Q1", "Q2", "Q3", "Q4", "NO_SNIP", "SNIP_ONLY"].map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Total authors</Label>
            <Input
              type="number"
              min={1}
              value={totalAuthors}
              onChange={(e) => setTotalAuthors(Number(e.target.value) || 1)}
              onBlur={recalc}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Your author position</Label>
            <select
              className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              value={authorPosition}
              onChange={(e) => {
                setAuthorPosition(Number(e.target.value));
                setTimeout(recalc, 0);
              }}
            >
              {authorOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value}. {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>EID</Label>
            <Input value={eid} onChange={(e) => setEid(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Cover date</Label>
            <Input value={coverDate} onChange={(e) => setCoverDate(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Scopus URL</Label>
            <Input value={scopusUrl} onChange={(e) => setScopusUrl(e.target.value)} />
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-sm font-medium">Calculated remuneration</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-[#0f4c5c]">
            {calc?.remuneration != null ? `₹${calc.remuneration.toLocaleString("en-IN")}` : "—"}
          </div>
          {calc?.error ? <p className="mt-1 text-sm text-amber-700">{calc.error}</p> : null}
          <div className="mt-2 text-xs text-slate-500">
            Base {calc?.base ?? "—"} · Point {calc?.point ?? "—"}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overrideDup} onChange={(e) => setOverrideDup(e.target.checked)} />
            Override prior-payment duplicate warning
          </label>
          {overrideDup ? (
            <Textarea
              className="mt-2"
              placeholder="Override reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          ) : null}
        </Card>

        {error ? <p className="text-sm text-rose-700">{error}</p> : null}

        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={busy}>
            Save draft
          </Button>
          <Button type="button" disabled={busy} onClick={() => save(true)}>
            Submit to HOD
          </Button>
        </div>
      </form>
    </div>
  );
}

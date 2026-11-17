import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api, apiFile, ApiError } from "@/lib/api"
import {
  readDatasets,
  readDefinition,
  readResult,
  readSaved,
  readSavedLists,
  readTemplates,
  type Definition,
  type RunBody,
  type Schedule,
  type Visibility,
} from "./model"

/**
 * Every call the Report studio makes, in one place, so a screen asks for
 * "the datasets" or "run this" and never builds a path. The contract is the
 * server's (`/api/reports/...`); the shapes are read through `model.ts`
 * so a field the server adds or leaves out does not break a screen.
 */

const BASE = "/api/reports"

export const KEYS = {
  datasets: ["report-studio", "datasets"] as const,
  templates: ["report-studio", "templates"] as const,
  saved: ["report-studio", "saved"] as const,
  one: (id: string) => ["report-studio", "saved", id] as const,
}

export function useDatasets() {
  return useQuery({
    queryKey: KEYS.datasets,
    queryFn: async () => readDatasets(await api(`${BASE}/datasets`)),
    staleTime: 5 * 60_000,
  })
}

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: KEYS.templates,
    enabled,
    queryFn: async () => readTemplates(await api(`${BASE}/templates`)),
    staleTime: 5 * 60_000,
  })
}

export function useSavedReports() {
  return useQuery({
    queryKey: KEYS.saved,
    queryFn: async () => readSavedLists(await api(`${BASE}/saved`)),
    staleTime: 0,
  })
}

export function useSavedReport(id: string | null) {
  return useQuery({
    queryKey: KEYS.one(id ?? ""),
    enabled: !!id,
    queryFn: async () => {
      const one = readSaved(await api(`${BASE}/saved/${id}`))
      if (!one) throw new ApiError(404, "That report could not be found.")
      return one
    },
    staleTime: 0,
  })
}

export function useRun() {
  return useMutation<ReturnType<typeof readResult>, ApiError, RunBody>({
    mutationFn: async (body) => readResult(await api(`${BASE}/run`, { method: "POST", json: body })),
  })
}

export function useRunSaved() {
  return useMutation<ReturnType<typeof readResult>, ApiError, string>({
    mutationFn: async (id) => readResult(await api(`${BASE}/saved/${id}/run`, { method: "POST", json: {} })),
  })
}

export function useAsk() {
  return useMutation<{ definition: Definition; explanation: string }, ApiError, string>({
    mutationFn: async (question) => {
      const raw = await api<{ definition?: unknown; explanation?: unknown }>(`${BASE}/ai`, {
        method: "POST",
        json: { question },
      })
      return {
        definition: readDefinition(raw?.definition),
        explanation: typeof raw?.explanation === "string" ? raw.explanation : "",
      }
    },
  })
}

export type SaveInput = {
  /** Present when an existing report is being updated. */
  id?: string
  name: string
  description: string
  visibility: Visibility
  definition: RunBody
}

export function useSave() {
  const qc = useQueryClient()
  return useMutation<NonNullable<ReturnType<typeof readSaved>>, ApiError, SaveInput>({
    mutationFn: async ({ id, ...body }) => {
      const raw = await api(id ? `${BASE}/saved/${id}` : `${BASE}/saved`, { method: id ? "PUT" : "POST", json: body })
      const one = readSaved(raw)
      if (!one) throw new ApiError(500, "The report was saved but the server did not say which one.")
      return one
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.saved }),
  })
}

export function useDuplicate() {
  const qc = useQueryClient()
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`${BASE}/saved/${id}/duplicate`, { method: "POST", json: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.saved }),
  })
}

export function useDelete() {
  const qc = useQueryClient()
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`${BASE}/saved/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.saved }),
  })
}

export type ScheduleInput = {
  frequency: Schedule["frequency"]
  day: number
  hour: number
  format: Schedule["format"]
  recipients: string[]
}

export function useSchedule(id: string) {
  const qc = useQueryClient()
  const done = () => {
    void qc.invalidateQueries({ queryKey: KEYS.saved })
    void qc.invalidateQueries({ queryKey: KEYS.one(id) })
  }
  const set = useMutation<unknown, ApiError, ScheduleInput>({
    mutationFn: (body) => api(`${BASE}/saved/${id}/schedule`, { method: "POST", json: body }),
    onSuccess: done,
  })
  const stop = useMutation<unknown, ApiError, void>({
    mutationFn: () => api(`${BASE}/saved/${id}/schedule`, { method: "DELETE" }),
    onSuccess: done,
  })
  return { set, stop }
}

export function useFeed(id: string) {
  const qc = useQueryClient()
  const done = () => {
    void qc.invalidateQueries({ queryKey: KEYS.saved })
    void qc.invalidateQueries({ queryKey: KEYS.one(id) })
  }
  const make = useMutation<string, ApiError, void>({
    mutationFn: async () => {
      const raw = await api<{ url?: unknown }>(`${BASE}/saved/${id}/feed`, { method: "POST", json: {} })
      if (typeof raw?.url !== "string" || !raw.url) throw new ApiError(500, "The server did not give a link.")
      return raw.url
    },
    onSuccess: done,
  })
  const revoke = useMutation<unknown, ApiError, void>({
    mutationFn: () => api(`${BASE}/saved/${id}/feed`, { method: "DELETE" }),
    onSuccess: done,
  })
  return { make, revoke }
}

/** Asks the server for the whole report as a file and saves it. Returns the file's name. */
export async function downloadReport(body: RunBody, format: "xlsx" | "pdf" | "csv", title: string): Promise<string> {
  const { blob, filename } = await apiFile(`${BASE}/export`, { ...body, format, title })
  const name = filename || `${title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "report"}.${format}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return name
}

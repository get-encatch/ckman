// Saved S3 connections that backups pick from.
import { queryOptions } from "@tanstack/react-query"

import { api } from "./client"

const enc = encodeURIComponent

export type StorageConnection = {
  connection_id: string
  name: string
  type: "s3" | "azure"
  azure: AzureTarget // Azure connections
  s3: {
    Endpoint: string
    AccessKeyID: string
    SecretAccessKey: string // always empty in responses
    Region: string
    UseSSL?: boolean
    CAFile?: string
    InsecureSkipVerify?: boolean
  }
  create_time: string
  update_time: string
}

// Azure Blob: blob service URL and a shared account key
export type AzureTarget = {
  endpoint: string // https://<account>.blob.core.windows.net
  account_name: string
  account_key: string // always empty in responses; empty on edit = keep
}

export type ConnectionInput = {
  name: string
  type: "s3" | "azure"
  azure: AzureTarget
  s3: {
    Endpoint: string
    AccessKeyID: string
    SecretAccessKey: string // empty on edit = keep the stored one
    Region: string
    InsecureSkipVerify?: boolean
  }
}

export const connectionsQuery = () =>
  queryOptions({
    queryKey: ["storage-connections"],
    queryFn: async () =>
      (await api.get<StorageConnection[] | null>(
        "/api/v1/storage/connections"
      )) ?? [],
  })

export const bucketsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ["storage-connections", connectionId, "buckets"],
    queryFn: async () =>
      (await api.get<string[] | null>(
        `/api/v1/storage/connections/${enc(connectionId)}/buckets`
      )) ?? [],
    enabled: connectionId !== "",
    staleTime: 30_000,
  })

export function createConnection(body: ConnectionInput) {
  return api.post<StorageConnection>("/api/v1/storage/connections", body)
}

export function updateConnection(id: string, body: ConnectionInput) {
  return api.put<StorageConnection>(
    `/api/v1/storage/connections/${enc(id)}`,
    body
  )
}

export function deleteConnection(id: string) {
  return api.delete(`/api/v1/storage/connections/${enc(id)}`)
}

// Tests settings without saving; with connection_id, empty keys come from it.
export function testConnection(
  body: ConnectionInput & { connection_id?: string }
) {
  return api.post<{ buckets: string[] | null }>(
    "/api/v1/storage/connections/test",
    body
  )
}

export function createBucket(id: string, name: string) {
  return api.post(`/api/v1/storage/connections/${enc(id)}/buckets`, { name })
}

// Bucket (S3) or container (Azure) naming rules, mirroring the server.
export function bucketProblem(
  name: string,
  type: "s3" | "azure" = "s3"
): string | null {
  if (type === "azure")
    return /^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){2,62}$/.test(name) &&
      name.length <= 63
      ? null
      : "Use 3–63 lowercase letters, digits or single hyphens, starting and ending with a letter or digit."
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name))
    return "Use 3–63 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit."
  if (name.includes("..")) return "No two dots in a row."
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name))
    return "Must not look like an IP address."
  return null
}

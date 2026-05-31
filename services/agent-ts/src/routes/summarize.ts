/**
 * `POST /v1/summarize` — port of agent-py's Phase 4-4b endpoint.
 *
 * Discriminated union on `mode`: file / conversation / compress /
 * project-breakdown. Three modes return JSON, compress returns
 * `{recap}` markdown. Wire shapes match agent-py byte-for-byte.
 */

import { Hono } from "hono"
import { z } from "zod"

import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"
import {
  resolveModel,
  summariseCompress,
  summariseConversation,
  summariseFile,
  summariseProjectBreakdown,
} from "../summarise"

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
})

const FileBody = z.object({
  mode: z.literal("file"),
  name: z.string().max(500).optional(),
  text: z.string().min(1).max(50_000),
  model: z.string().max(100).optional(),
})

const ConversationBody = z.object({
  mode: z.literal("conversation"),
  messages: z.array(MessageSchema).min(1).max(200),
  model: z.string().max(100).optional(),
})

const CompressBody = z.object({
  mode: z.literal("compress"),
  messages: z.array(MessageSchema).min(2).max(200),
  model: z.string().max(100).optional(),
})

const ProjectBreakdownBody = z.object({
  mode: z.literal("project-breakdown"),
  goal: z.string().min(1).max(4000),
  existingTitles: z.array(z.string().max(300)).max(100).optional(),
  model: z.string().max(100).optional(),
})

const BodySchema = z.discriminatedUnion("mode", [
  FileBody,
  ConversationBody,
  CompressBody,
  ProjectBreakdownBody,
])

export const summarizeRoutes = new Hono<{ Variables: AuthVars }>()

summarizeRoutes.post("/v1/summarize", requireAuth, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: "invalid_request", message: "Body must be JSON." }, 400)
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      422,
    )
  }

  const modelId = resolveModel(parsed.data.model)
  const data = parsed.data

  const result =
    data.mode === "file"
      ? await summariseFile(modelId, data.name, data.text)
      : data.mode === "conversation"
        ? await summariseConversation(modelId, data.messages)
        : data.mode === "compress"
          ? await summariseCompress(modelId, data.messages)
          : await summariseProjectBreakdown(modelId, data.goal, data.existingTitles)

  if (!result.ok) {
    return c.json({ code: result.code, message: result.message }, 502)
  }
  return c.json(result.payload)
})

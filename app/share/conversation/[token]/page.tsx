import { notFound } from "next/navigation"

import { resolveShare } from "@/server/share/resolve"
import { shareReadsFromBackend } from "@/shared/share-backend"
import { BackendShareView } from "@/components/share/backend-share-view"
import { SharedConversationView } from "@/components/share/shared-conversation-view"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedConversationPage({ params }: PageProps) {
  const { token } = await params
  // Backend configured → the browser reads the share from
  // `GET /v1/share/{token}`; the Next server touches no database.
  if (shareReadsFromBackend(process.env.NEXT_PUBLIC_AGENT_PY_URL)) {
    return <BackendShareView kind="conversation" token={token} />
  }

  const share = await resolveShare(token)
  if (!share || share.kind !== "conversation") notFound()
  return <SharedConversationView share={share} />
}

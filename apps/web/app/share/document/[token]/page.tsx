import { BackendShareView } from "@/components/share/backend-share-view"

interface PageProps {
  params: Promise<{ token: string }>
}

// The browser reads the share from agent-py (`GET /v1/share/{token}`,
// PLAN-frontend-backend-split Q127); the Next server touches no database.
export default async function SharedDocumentPage({ params }: PageProps) {
  const { token } = await params
  return <BackendShareView kind="document" token={token} />
}

import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { ApiError } from "@/lib/api"
import { useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Composer } from "@/ui/composer"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Field, Input } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { toast } from "@/ui/toast"

type Created = { id: string }

/**
 * "Ask a question": a thread for everybody signed in, opened from the Threads
 * tab of Discussions.
 *
 * It sends `visibility: "PUBLIC"` and nothing that is private (no claim, no
 * named audience), so the words on the button are true: every colleague can
 * read it and answer. A question about one's own claim is a different thing
 * that goes to the research office from Messages, and the dialog says so
 * rather than letting somebody put a claim number in public by accident.
 * Without it the tab lists questions nobody can start from there.
 */
export function AskQuestion({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const create = useApiMutation<{ title: string; body: string; visibility: "PUBLIC" }, Created>("/api/threads", {
    invalidates: [["threads"]],
  })
  const canSend = title.trim().length >= 4 && body.trim().length > 0 && !create.isPending

  async function send() {
    if (!canSend) return
    try {
      const made = await create.mutateAsync({ title: title.trim(), body: body.trim(), visibility: "PUBLIC" })
      toast.ok("Question posted for everybody")
      onClose()
      navigate(`/discussions/${made.id}`)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Ask a question</DialogTitle>
          <DialogDescription>
            Everybody signed in can read it and answer. For a question about your own claim, write to the research
            office from Messages instead.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Title" hint="What somebody scanning the list would recognise. At least four characters.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Which journals turn papers around fastest?"
              autoFocus
            />
          </Field>
          <Composer
            value={body}
            onChange={setBody}
            label="Your question"
            rows={4}
            placeholder="What would you like to know? Type @ to name a colleague or a journal."
          />
          {create.error instanceof ApiError && <InlineError message={create.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSend} onClick={() => void send()}>
            {create.isPending ? "Posting…" : "Post the question"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

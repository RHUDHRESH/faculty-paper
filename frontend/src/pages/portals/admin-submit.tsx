"use client"

import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { PageHeader } from "@/components/layout/page"
import { PublicationForm } from "@/components/publication-form"
import type { Claim } from "@/lib/api"

export function AdminSubmitClaimPage() {
  const navigate = useNavigate()

  function onSuccess(claim: Claim) {
    if (claim.status === "DRAFT") {
      toast.success("Draft saved")
      navigate("/admin")
    }
  }

  return (
    <div>
      <PageHeader
        title="Submit for faculty"
        subtitle="Create a publication ticket on behalf of a faculty member"
      />
      <PublicationForm mode="admin" onSuccess={onSuccess} />
    </div>
  )
}

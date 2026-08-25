import { useState } from "react"
import { MoreHorizontal, Trash2 } from "lucide-react"

import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import {
  Checkbox,
  DateInput,
  Field,
  Input,
  NumberInput,
  PasswordInput,
  Radio,
  Switch,
  Textarea,
} from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { Distribution, MixBar, RankedBars, Trend } from "@/ui/chart"
import { money, Stage, stageOf } from "@/ui/paper"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { Table } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Tooltip, TooltipProvider } from "@/ui/tooltip"

/**
 * Every component on one page, so they can be looked at together.
 *
 * Four people built these in parallel and they typecheck, which says nothing
 * about whether they belong to the same interface. Two components can each be
 * defensible and still disagree about what a 32px control looks like, and the
 * only way to find that out is to put them side by side.
 *
 * Not linked from the sidebar. Reachable at /gallery while the rebuild is on,
 * and deleted before the switch.
 */

const DEPARTMENTS = [
  "ECE", "CSE", "EEE", "MECH", "IT", "AI&DS", "AI&ML", "BME", "EIE", "AGRI",
  "MBA", "S&H-PHY", "S&H-CHY", "S&H-MATHS", "S&H-ENGLISH", "Mechanical (R&D)",
].map((d) => ({ value: d, label: d }))

type Row = { id: string; title: string; who: string; dept: string; amount: number; status: string }

const ROWS: Row[] = [
  { id: "1", title: "A resilient and carbon-aware virtual power plant coordination framework", who: "Dr. Thirumalai M", dept: "ECE", amount: 30504, status: "PAID" },
  { id: "2", title: "Optimizing Segmented Bimorph Piezoelectric Harvesters", who: "Dr. Manikandan S P", dept: "ECE", amount: 64584, status: "PRINCIPAL_APPROVED" },
  { id: "3", title: "Transforming urban resilience with energy-efficient IoT-enabled blockchain systems for disaster response", who: "Ms. M. Karthiga", dept: "ECE", amount: 0, status: "CLEARED" },
  { id: "4", title: "SnS2/MWCNT hybrid electrodes with exceptional energy density", who: "Dr. K. Chanthirasekaran", dept: "ECE", amount: 28966, status: "SUBMITTED" },
  { id: "5", title: "Synthesis of biomass derived N, S co-doped carbon dot", who: "Dr. Thirumalai M", dept: "S&H-CHY", amount: 21500, status: "REJECTED" },
]

export function Gallery() {
  const [dept, setDept] = useState("")
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [checked, setChecked] = useState(true)
  const [on, setOn] = useState(false)
  const [radio, setRadio] = useState("a")

  return (
    <TooltipProvider>
      <div className="page space-y-12 pb-24">
        <header>
          <PageTitle>Component gallery</PageTitle>
          <Sub className="mt-1">
            Everything in <code className="font-mono text-sm">src/ui</code>, together, so
            disagreements between them are visible.
          </Sub>
        </header>

        <Block title="Type">
          <div className="space-y-2">
            <PageTitle>Page title — 22px</PageTitle>
            <SectionTitle>Section title — 16px</SectionTitle>
            <p className="text-base">Body — 14px. The size most of the app is set in.</p>
            <p className="text-sm">Dense row and secondary text — 13px.</p>
            <Meta>Metadata beside content — 12px muted.</Meta>
            <div>
              <ColumnLabel>Column label</ColumnLabel>
            </div>
          </div>
        </Block>

        <Block title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="primary">Clear 12 papers</Button>
            <Button>Export</Button>
            <Button kind="quiet">Cancel</Button>
            <Button kind="danger">
              <Trash2 />
              Delete
            </Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="More">
              <MoreHorizontal />
            </Button>
          </div>
        </Block>

        <Block title="Stage — how a paper is going">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {["DRAFT", "SUBMITTED", "CLEARED", "PRINCIPAL_APPROVED", "PAID", "REJECTED"].map(
              (s) => (
                <div key={s}>
                  <Meta className="mb-1 block font-mono text-xs">{s}</Meta>
                  <Stage stage={stageOf(s)} />
                  <p className="mt-1 text-xs text-fg-muted">{stageOf(s).who}</p>
                </div>
              )
            )}
          </div>
        </Block>

        <Block title="Table">
          <Table
            rows={ROWS}
            getKey={(r) => r.id}
            rowLink={(r) => `/papers/${r.id}`}
            minWidth="52rem"
            columns={[
              { key: "title", header: "Paper", className: "max-w-[24rem]", cell: (r) => <span className="line-clamp-2">{r.title}</span> },
              { key: "who", header: "Author", cell: (r) => r.who },
              { key: "dept", header: "Department", cell: (r) => <Meta>{r.dept}</Meta> },
              { key: "amount", header: "Amount", align: "right", cell: (r) => money(r.amount) },
              { key: "status", header: "Stage", className: "w-40", cell: (r) => <Stage stage={stageOf(r.status)} /> },
            ]}
          />
        </Block>

        <Block title="Fields">
          <div className="grid max-w-xl gap-4">
            <Field label="Paper title" hint="As it appears on the published article">
              <Input placeholder="Enter the title" />
            </Field>
            <Field label="Password">
              <PasswordInput placeholder="Type to see the reveal control" />
            </Field>
            <Field label="Department">
              <Combobox
                value={dept}
                onChange={setDept}
                options={DEPARTMENTS}
                placeholder="Any department"
                aria-label="Department"
              />
            </Field>
            <Field label="Why is this being changed?" error="Say why — the person is told.">
              <Textarea placeholder="A sentence" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Amount">
                <NumberInput unit="₹" placeholder="0" />
              </Field>
              <Field label="Published on">
                <DateInput />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} label="Engineering journal" />
              <Radio name="g" value="a" checked={radio === "a"} onChange={() => setRadio("a")} label="First author" />
              <Radio name="g" value="b" checked={radio === "b"} onChange={() => setRadio("b")} label="Co-author" />
              <Switch checked={on} onCheckedChange={setOn} label="Notify me" />
            </div>
          </div>
        </Block>

        <Block title="Overlays">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Button onClick={() => setSheet(true)}>Open sheet</Button>
            <Button kind="danger" onClick={() => setConfirm(true)}>
              Destructive confirm
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button kind="quiet" size="icon" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem shortcut="E">Edit</MenuItem>
                <MenuItem shortcut="D">Duplicate</MenuItem>
                <MenuSeparator />
                <MenuItem danger>Delete</MenuItem>
              </MenuContent>
            </Menu>
            <Tooltip content="Needs an institutional subscription">
              <Button kind="quiet">Hover me</Button>
            </Tooltip>
            <Button kind="quiet" onClick={() => toast.ok("Cleared — 12 papers sent to the Principal")}>
              Toast
            </Button>
          </div>
        </Block>

        <Block title="Charts — every one of them also a table">
          <div className="space-y-10">
            <Trend
              title="Papers filed each month"
              caption="The last twelve months."
              dimension="Month"
              points={BY_MONTH}
            />

            <RankedBars
              title="Departments by amount paid"
              caption="Point at a name to go to the department."
              dimension="Department"
              unit="money"
              points={BY_DEPT}
              limit={6}
            />

            <div className="grid gap-10 lg:grid-cols-2">
              <MixBar
                title="Where the money went"
                dimension="Quartile"
                unit="money"
                points={BY_QUARTILE}
              />
              <Distribution
                title="Papers by year of publication"
                dimension="Year"
                points={BY_YEAR}
              />
            </div>

            <RankedBars
              title="A chart with nothing in it"
              caption="What an empty one says."
              dimension="Department"
              points={[]}
            />
          </div>
        </Block>

        <Block title="Loading, empty, error — three different sentences">
          <div className="grid gap-6 lg:grid-cols-3">
            <div>
              <ColumnLabel>Loading</ColumnLabel>
              <div className="mt-2">
                <SkeletonRows rows={4} />
              </div>
            </div>
            <div>
              <ColumnLabel>Empty</ColumnLabel>
              <div className="mt-2">
                <EmptyState
                  title="Nothing filed yet"
                  message="File a paper and it goes to the research cell to be checked."
                />
              </div>
            </div>
            <div>
              <ColumnLabel>Error</ColumnLabel>
              <div className="mt-2">
                <ErrorState
                  title="Could not load your papers"
                  message="The server did not answer. Nothing was lost."
                  onRetry={() => toast.info("Retried")}
                />
              </div>
            </div>
          </div>
          <div className="mt-6 space-y-2">
            <InlineError message="This section could not load." />
            <Callout tone="info" title="No UGC-CARE list loaded">
              That column reads “Not checked” on every row, which is the truth.
            </Callout>
            <Callout tone="caution" title="2026 is a part year">
              Eight months against twelve, so the change column reads low until December.
            </Callout>
            <Callout tone="critical" title="71 papers have waited over a month">
              The oldest has been at its step for 53 days.
            </Callout>
            <Callout tone="positive" title="Nothing missing">
              Every row NAAC asks about can be answered.
            </Callout>
          </div>
        </Block>

        <Dialog open={dialog} onOpenChange={setDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Correct this row</DialogTitle>
              <DialogDescription>
                One field, one reason, recorded against the ticket.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field label="ISSN">
                <Input defaultValue="0272-8842" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button kind="quiet" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button kind="primary" onClick={() => setDialog(false)}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          danger
          title="Empty this system?"
          description="Every publication and payment record is removed. There is no undo."
          confirmLabel="Empty the system"
          requirePhrase="DELETE EVERYTHING"
          reasonLabel="Why is the system being emptied?"
          onConfirm={() => toast.ok("Nothing happened — this is the gallery")}
        />

        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Associate Professor</SheetTitle>
              <SheetDescription>Designation · 796 publications</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <ul className="divide-y divide-line">
                {ROWS.map((r) => (
                  <li key={r.id} className="row px-1 py-3">
                    <p className="line-clamp-2 text-base">{r.title}</p>
                    <Meta>
                      {r.who} · {r.dept}
                    </Meta>
                  </li>
                ))}
              </ul>
            </SheetBody>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  )
}

const BY_MONTH = [
  { key: "2025-09", label: "Sep", count: 41 },
  { key: "2025-10", label: "Oct", count: 66 },
  { key: "2025-11", label: "Nov", count: 58 },
  { key: "2025-12", label: "Dec", count: 27 },
  { key: "2026-01", label: "Jan", count: 73 },
  { key: "2026-02", label: "Feb", count: 91 },
  { key: "2026-03", label: "Mar", count: 84 },
  { key: "2026-04", label: "Apr", count: 62 },
  { key: "2026-05", label: "May", count: 55 },
  { key: "2026-06", label: "Jun", count: 38 },
  { key: "2026-07", label: "Jul", count: 47 },
  { key: "2026-08", label: "Aug", count: 69 },
]

// A deliberately long name, because that is the one that breaks the layout.
const BY_DEPT = [
  { key: "cse", label: "Computer Science and Engineering", count: 612, amount: 8_940_000, to: "/people" },
  { key: "ece", label: "Electronics and Communication", count: 431, amount: 6_120_000, to: "/people" },
  { key: "mech", label: "Mechanical Engineering", count: 288, amount: 4_050_000, to: "/people" },
  { key: "civil", label: "Civil Engineering", count: 174, amount: 2_310_000, to: "/people" },
  { key: "bio", label: "Biotechnology", count: 121, amount: 1_640_000, to: "/people" },
  { key: "chem", label: "Chemistry", count: 96, amount: 1_180_000 },
  { key: "maths", label: "Mathematics", count: 74, amount: 890_000 },
  { key: "phys", label: "Physics", count: 51, amount: 620_000 },
]

const BY_QUARTILE = [
  { key: "Q1", count: 402, amount: 9_850_000 },
  { key: "Q2", count: 511, amount: 7_240_000 },
  { key: "Q3", count: 388, amount: 3_910_000 },
  { key: "Q4", count: 246, amount: 1_720_000 },
  { key: "Unranked", count: 118, amount: 430_000 },
]

const BY_YEAR = [
  { key: "2019", count: 118 },
  { key: "2020", count: 164 },
  { key: "2021", count: 249 },
  { key: "2022", count: 402 },
  { key: "2023", count: 531 },
  { key: "2024", count: 604 },
  { key: "2025", count: 588 },
  { key: "2026", count: 341 },
]

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <SectionTitle>{title}</SectionTitle>
      <div className="border-t border-line pt-4">{children}</div>
    </section>
  )
}

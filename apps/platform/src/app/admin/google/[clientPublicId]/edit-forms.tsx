import { DAY_LABELS, MAX_RANGES_PER_DAY, NEW_SPECIAL_ROWS } from "@/lib/google-business/hours";
import { DESCRIPTION_MAX, POST_SUMMARY_MAX } from "@/lib/google-business/client";
import { WEEKDAYS, type ProfileSnapshot, type SpecialDay } from "@/lib/google-business/types";
import type { WorkspacePhoto, WorkspaceRequest } from "@/db/repositories/admin/google-profile";
import { ActionForm } from "../action-form";
import { descriptionAction, hoursAction, photoAction, postAction, specialHoursAction } from "../actions";

/**
 * The operator's edit forms. Plain HTML forms, filled with what Google held
 * at the last sync; each submit re-reads Google before writing (see
 * `google-edits.ts`), so a value changed on Google since then is logged as
 * the "before", not overwritten blind.
 */

const CTA_LABELS: Array<[string, string]> = [
  ["", "No button"],
  ["LEARN_MORE", "Learn more"],
  ["BOOK", "Book"],
  ["ORDER", "Order online"],
  ["SHOP", "Shop"],
  ["SIGN_UP", "Sign up"],
  ["CALL", "Call now (uses the profile's phone)"],
];

function AnswersAsk({ requests }: { requests: WorkspaceRequest[] }) {
  const open = requests.filter((r) => r.status === "open");
  if (open.length === 0) return null;
  return (
    <>
      <label>
        Answers the client&rsquo;s ask
        <select name="request" defaultValue="">
          <option value="">None</option>
          {open.map((r) => (
            <option key={r.publicId} value={r.publicId}>
              {r.body.length > 70 ? `${r.body.slice(0, 69)}…` : r.body}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">Linked in the change log. Mark the ask done once Google shows it.</p>
    </>
  );
}

export function HoursForm({ clientPublicId, snapshot, requests }: { clientPublicId: string; snapshot: ProfileSnapshot; requests: WorkspaceRequest[] }) {
  const overflow = WEEKDAYS.some((d) => (snapshot.hours?.[d].length ?? 0) > MAX_RANGES_PER_DAY);
  return (
    <ActionForm
      action={hoursAction}
      hidden={{ client: clientPublicId }}
      className="gp-hours-form"
      buttons={[{ label: "Save hours to Google", value: "save", pendingLabel: "Saving…", confirm: "Change this business's hours on Google?" }]}
    >
      {overflow && (
        <p className="notice notice-info">
          Google has more than two time ranges on a day. Saving here keeps the first two; edit on Google to keep more.
        </p>
      )}
      {WEEKDAYS.map((day) => {
        const ranges = snapshot.hours?.[day] ?? [];
        const allDay = ranges.length === 1 && ranges[0]!.open === "00:00" && ranges[0]!.close === "24:00";
        const mode = ranges.length === 0 ? "closed" : allDay ? "24h" : "open";
        return (
          <div className="gp-day" key={day}>
            <span className="gp-day-label">{DAY_LABELS[day].long}</span>
            <select name={`${day}.mode`} defaultValue={mode} aria-label={`${DAY_LABELS[day].long}: open or closed`}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="24h">Open 24 hours</option>
            </select>
            <span className="gp-ranges">
              {Array.from({ length: MAX_RANGES_PER_DAY }, (_, i) => {
                const range = allDay ? undefined : ranges[i];
                const close = range?.close === "24:00" ? "00:00" : range?.close;
                return (
                  <span className="gp-range-pair" key={i}>
                    <input type="time" name={`${day}.${i}.open`} defaultValue={range?.open ?? ""} aria-label={`${DAY_LABELS[day].long} range ${i + 1} opens`} />
                    –
                    <input type="time" name={`${day}.${i}.close`} defaultValue={close ?? ""} aria-label={`${DAY_LABELS[day].long} range ${i + 1} closes`} />
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
      <AnswersAsk requests={requests} />
    </ActionForm>
  );
}

function SpecialRow({ index, day }: { index: number; day?: SpecialDay }) {
  return (
    <div className="gp-special-row">
      <input type="date" name={`special.${index}.date`} defaultValue={day?.date ?? ""} aria-label={`Special day ${index + 1} date`} />
      <select name={`special.${index}.mode`} defaultValue={day ? (day.closed ? "closed" : "open") : ""} aria-label={`Special day ${index + 1}`}>
        {!day && <option value="">—</option>}
        <option value="closed">Closed</option>
        <option value="open">Open</option>
        {day && <option value="remove">Remove</option>}
      </select>
      <span className="gp-range-pair">
        <input type="time" name={`special.${index}.open`} defaultValue={day?.open ?? ""} aria-label="Opens" />
        –
        <input type="time" name={`special.${index}.close`} defaultValue={day?.close === "24:00" ? "00:00" : (day?.close ?? "")} aria-label="Closes" />
      </span>
    </div>
  );
}

export function SpecialHoursForm({
  clientPublicId,
  snapshot,
  requests,
  now = new Date(),
}: {
  clientPublicId: string;
  snapshot: ProfileSnapshot;
  requests: WorkspaceRequest[];
  now?: Date;
}) {
  const today = now.toISOString().slice(0, 10);
  const past = snapshot.specialHours.filter((d) => d.date < today);
  const upcoming = snapshot.specialHours.filter((d) => d.date >= today);
  const rows = past.length + upcoming.length + NEW_SPECIAL_ROWS;

  // Google replaces the whole list on save, so past days ride along as
  // hidden rows: saving next month's holiday must not erase last year's.
  const hidden: Record<string, string> = { client: clientPublicId, rows: String(rows) };
  past.forEach((day, i) => {
    hidden[`special.${i}.date`] = day.date;
    hidden[`special.${i}.mode`] = day.closed ? "closed" : "open";
    if (!day.closed) {
      hidden[`special.${i}.open`] = day.open ?? "";
      hidden[`special.${i}.close`] = day.close === "24:00" ? "00:00" : (day.close ?? "");
    }
  });

  return (
    <ActionForm
      action={specialHoursAction}
      hidden={hidden}
      buttons={[{ label: "Save special hours to Google", value: "save", pendingLabel: "Saving…", confirm: "Change this business's special hours on Google?" }]}
    >
      {upcoming.map((day, i) => (
        <SpecialRow key={day.date} index={past.length + i} day={day} />
      ))}
      {Array.from({ length: NEW_SPECIAL_ROWS }, (_, i) => (
        <SpecialRow key={`new-${i}`} index={past.length + upcoming.length + i} />
      ))}
      <p className="field-hint">
        A closed day or different hours for one date: holidays, a stocktake, a late opening. {past.length > 0 ? `${past.length} past ${past.length === 1 ? "day is" : "days are"} kept as they are.` : ""}
      </p>
      <AnswersAsk requests={requests} />
    </ActionForm>
  );
}

export function DescriptionForm({ clientPublicId, snapshot, requests }: { clientPublicId: string; snapshot: ProfileSnapshot; requests: WorkspaceRequest[] }) {
  return (
    <ActionForm
      action={descriptionAction}
      hidden={{ client: clientPublicId }}
      buttons={[{ label: "Save description to Google", value: "save", pendingLabel: "Saving…", confirm: "Change this business's description on Google?" }]}
    >
      <label>
        Description
        <textarea name="description" rows={6} maxLength={DESCRIPTION_MAX} defaultValue={snapshot.description ?? ""} required />
      </label>
      <p className="field-hint">Up to {DESCRIPTION_MAX} characters. No links, and only what the business has confirmed is true.</p>
      <AnswersAsk requests={requests} />
    </ActionForm>
  );
}

function PhotoSelect({ photos, name = "photo", optional }: { photos: WorkspacePhoto[]; name?: string; optional: boolean }) {
  return (
    <select name={name} defaultValue="">
      <option value="">{optional ? "No photo" : "Pick a photo"}</option>
      {photos.map((p) => (
        <option key={p.publicId} value={p.publicId}>
          {p.title ? `${p.title} — ${p.filename}` : p.filename}
          {p.width && p.height ? ` (${p.width}×${p.height})` : ""}
        </option>
      ))}
    </select>
  );
}

export function PostForm({ clientPublicId, photos, requests }: { clientPublicId: string; photos: WorkspacePhoto[]; requests: WorkspaceRequest[] }) {
  return (
    <ActionForm
      action={postAction}
      hidden={{ client: clientPublicId }}
      buttons={[{ label: "Publish post", value: "publish", pendingLabel: "Publishing…", confirm: "Publish this post on the client's Google profile? It is public straight away." }]}
    >
      <label>
        Post
        <textarea name="summary" rows={5} maxLength={POST_SUMMARY_MAX} required placeholder="What's new: a finished job, a seasonal offer, a closure." />
      </label>
      <label className="gp-photo-choice">
        Photo from their media library
        <PhotoSelect photos={photos} optional />
      </label>
      {photos.length === 0 && <p className="field-hint">No ready photos in their library yet.</p>}
      <label>
        Button
        <select name="ctaType" defaultValue="">
          {CTA_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Button link
        <input type="url" name="ctaUrl" placeholder="https://…" />
      </label>
      <p className="field-hint">Not needed for Call now. Google fetches the photo once, from a link that expires in 30 minutes.</p>
      <AnswersAsk requests={requests} />
    </ActionForm>
  );
}

export function PhotoForm({ clientPublicId, photos }: { clientPublicId: string; photos: WorkspacePhoto[] }) {
  if (photos.length === 0) return <p className="muted">No ready photos in their media library yet.</p>;
  return (
    <ActionForm
      action={photoAction}
      hidden={{ client: clientPublicId }}
      buttons={[{ label: "Add to Google profile", value: "add", pendingLabel: "Sending…", confirm: "Add this photo to the client's Google profile? It is public once Google processes it." }]}
    >
      <label className="gp-photo-choice">
        Photo
        <PhotoSelect photos={photos} optional={false} />
      </label>
    </ActionForm>
  );
}

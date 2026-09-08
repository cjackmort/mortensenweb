import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { sites } from "./sites";
import { changeRequests } from "./operations";
import {
  jobStatusEnum,
  mediaAssetStatusEnum,
  mediaDerivativeKindEnum,
  mediaUploadStatusEnum,
} from "./enums";

/**
 * The client media library.
 *
 * Three ideas carry this schema, and each one is a defence against a specific
 * way media libraries go wrong.
 *
 * **The original is immutable.** `media_assets.storage_key` points at the exact
 * bytes the client uploaded, and nothing ever writes to that key again.
 * Everything else — thumbnails, responsive sizes — is a row in
 * `media_derivatives` pointing at a different key. A regenerated derivative
 * replaces a derivative, never the original. This is the property that makes
 * "we compressed your artwork and now the good copy is gone" impossible rather
 * than merely unlikely.
 *
 * **A folder tree is a path, not just a parent pointer.** `path` is the
 * materialised lowercase route to a folder (`/artwork/2026`). It gives sibling
 * uniqueness through one unique index, descendant queries through a `LIKE`
 * rather than a recursive CTE, and — the reason it exists — cycle detection
 * that is a string comparison instead of a graph walk. Moving A into its own
 * descendant is caught by asking whether the destination path starts with the
 * path of A.
 *
 * **Readiness is a server fact.** An asset reaches `ready` only after the
 * server has read the assembled bytes, confirmed the checksum the client
 * declared, and sniffed the format from the bytes themselves. A browser
 * reporting success moves nothing.
 */

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const mediaFolders = pgTable(
  "media_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    /** Tenancy key. Every query in the client repository filters on this. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Null means a top-level folder. Self-referential, declared lazily because
     * the table is still being defined at this point.
     */
    parentId: uuid("parent_id").references((): AnyPgColumn => mediaFolders.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    /**
     * Materialised lowercase path, always leading-slashed: `/artwork/2026`.
     *
     * Maintained by the repository on create, rename and move — every one of
     * which also rewrites the paths of the subtree. That rewrite is the cost of
     * this design, and it buys sibling uniqueness, subtree queries and cycle
     * detection without a recursive CTE in any of them.
     */
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Trash. A folder in the trash keeps its rows and its path. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_folders_public_id_key").on(t.publicId),
    // Sibling uniqueness, expressed once. Two folders cannot share a path
    // within a tenant, and a path encodes its parent — so this is also
    // "no two children of the same parent share a name".
    //
    // Partial on `deleted_at IS NULL` so a name is reusable after its folder is
    // trashed; a client who deletes "Drafts" and makes a new one should not be
    // told the name is taken by something they cannot see.
    uniqueIndex("media_folders_org_path_key")
      .on(t.organizationId, t.path)
      .where(sql`deleted_at IS NULL`),
    index("media_folders_org_parent_idx").on(t.organizationId, t.parentId),
    index("media_folders_org_path_idx").on(t.organizationId, t.path),
    check("media_folders_name_not_blank", sql`length(btrim(${t.name})) > 0`),
    // A tree this deep is a mistake rather than an intention, and the bound
    // keeps path rewrites cheap.
    check(
      "media_folders_depth_bounded",
      sql`${t.depth} >= 0 AND ${t.depth} <= 10`,
    ),
    check("media_folders_path_rooted", sql`${t.path} LIKE '/%'`),
    // A folder cannot be its own parent. Deeper cycles are refused by the
    // repository using the materialised path; the trivial case is worth
    // refusing in the database too.
    check(
      "media_folders_no_self_parent",
      sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Null means the library root. A deleted folder sets this null rather than
     * cascading — losing a folder must never lose the artwork inside it.
     */
    folderId: uuid("folder_id").references(() => mediaFolders.id, {
      onDelete: "set null",
    }),

    status: mediaAssetStatusEnum("status").notNull().default("uploading"),

    /**
     * The original bytes. Written once, never overwritten.
     *
     * Null while the upload is still in parts: there is no assembled object to
     * point at yet, and a key that resolves to nothing is worse than no key.
     */
    storageKey: text("storage_key"),

    /** Exactly what the file was called. Display only, never used as a path. */
    originalFilename: text("original_filename").notNull(),
    /** Sniffed from the bytes at finalisation, never the claim of the browser. */
    contentType: text("content_type"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    /**
     * SHA-256 of the assembled original.
     *
     * Declared by the client when the session opens and recomputed by the
     * server over the bytes it actually assembled. A mismatch fails the upload:
     * it means the parts that arrived are not the file that was chosen, which
     * is either corruption or content substituted mid-session.
     */
    checksumSha256: text("checksum_sha256"),

    width: integer("width"),
    height: integer("height"),
    /** True when the format carries transparency that must not be flattened. */
    hasAlpha: boolean("has_alpha"),
    /** EXIF orientation, 1-8. Applied when generating derivatives. */
    orientation: integer("orientation"),

    title: text("title"),
    description: text("description"),

    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /** Why this asset is `failed` or `quarantined`, in words a client can read. */
    failureReason: text("failure_reason"),

    /** Trash. Recoverable until an operator purges it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_assets_public_id_key").on(t.publicId),
    uniqueIndex("media_assets_storage_key_key").on(t.storageKey),
    index("media_assets_org_status_idx").on(t.organizationId, t.status),
    index("media_assets_org_folder_idx").on(t.organizationId, t.folderId),
    index("media_assets_org_created_idx").on(t.organizationId, t.createdAt),
    // Backs the library search box.
    index("media_assets_org_filename_idx").on(
      t.organizationId,
      t.originalFilename,
    ),
    check("media_assets_size_nonnegative", sql`${t.byteSize} >= 0`),
    check(
      "media_assets_orientation_valid",
      sql`${t.orientation} IS NULL OR (${t.orientation} >= 1 AND ${t.orientation} <= 8)`,
    ),
    // A ready asset must actually point at bytes. This is what the rule "the
    // browser cannot make something ready" reduces to, so it is enforced here
    // as well as in code.
    check(
      "media_assets_ready_has_object",
      sql`${t.status} <> 'ready' OR (${t.storageKey} IS NOT NULL AND ${t.checksumSha256} IS NOT NULL AND ${t.byteSize} > 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Derivatives
// ---------------------------------------------------------------------------

export const mediaDerivatives = pgTable(
  "media_derivatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    kind: mediaDerivativeKindEnum("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One derivative per kind per asset. Regeneration replaces the row rather
    // than accumulating copies nobody can tell apart.
    uniqueIndex("media_derivatives_asset_kind_key").on(t.assetId, t.kind),
    uniqueIndex("media_derivatives_storage_key_key").on(t.storageKey),
    index("media_derivatives_asset_idx").on(t.assetId),
    check("media_derivatives_size_positive", sql`${t.byteSize} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Upload sessions
// ---------------------------------------------------------------------------

export const mediaUploads = pgTable(
  "media_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    status: mediaUploadStatusEnum("status").notNull().default("pending"),

    /**
     * What the client says it is sending. Every one of these is checked at
     * finalisation against what actually arrived.
     */
    declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
    declaredChecksum: text("declared_checksum").notNull(),
    declaredFilename: text("declared_filename").notNull(),
    declaredContentType: text("declared_content_type").notNull(),

    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),

    /**
     * An abandoned session is garbage with a deadline on it.
     *
     * The sweeper deletes the parts and the placeholder asset once this passes,
     * which is what stops a client who closed a tab mid-upload from consuming
     * their quota forever.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_uploads_public_id_key").on(t.publicId),
    index("media_uploads_org_status_idx").on(t.organizationId, t.status),
    index("media_uploads_expiry_idx").on(t.status, t.expiresAt),
    check(
      "media_uploads_part_count_bounded",
      sql`${t.partCount} >= 1 AND ${t.partCount} <= 2000`,
    ),
    check("media_uploads_part_size_positive", sql`${t.partSize} > 0`),
    check(
      "media_uploads_declared_bytes_positive",
      sql`${t.declaredBytes} > 0`,
    ),
  ],
);

export const mediaUploadParts = pgTable(
  "media_upload_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => mediaUploads.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    storageKey: text("storage_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Re-sending a part is how retry works, so the same part number arriving
    // twice must be one row and not two. This unique index is what makes an
    // interrupted upload resumable rather than corrupting.
    uniqueIndex("media_upload_parts_upload_number_key").on(
      t.uploadId,
      t.partNumber,
    ),
    index("media_upload_parts_upload_idx").on(t.uploadId),
    check("media_upload_parts_number_positive", sql`${t.partNumber} >= 1`),
    check("media_upload_parts_size_positive", sql`${t.byteSize} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Derivative jobs
// ---------------------------------------------------------------------------

export const mediaJobs = pgTable(
  "media_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    /** Backoff. The claimer only takes rows whose time has come. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set when a runner claims this row and cleared when it finishes.
     *
     * A claim still set well past the plausible duration of a job is a runner
     * that died, and the claimer takes it back — which is what makes a crashed
     * background function recoverable rather than a job stuck at `running`
     * forever.
     */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_jobs_public_id_key").on(t.publicId),
    // One outstanding job per asset. Queueing a second while the first is
    // pending would have two runners writing the same derivative keys.
    uniqueIndex("media_jobs_asset_open_key")
      .on(t.assetId)
      .where(sql`status IN ('queued', 'running')`),
    index("media_jobs_claim_idx").on(t.status, t.nextAttemptAt),
    check(
      "media_jobs_attempts_bounded",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Request linkage
// ---------------------------------------------------------------------------

export const requestAssets = pgTable(
  "request_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => changeRequests.id, { onDelete: "cascade" }),
    /**
     * `restrict` rather than `cascade`, and deliberately.
     *
     * An asset a request depends on must not be deletable out from under it.
     * The delete path in the library checks this and refuses with an
     * explanation naming the request; the constraint is what makes that check
     * impossible to forget in a future code path.
     */
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),

    /**
     * What the asset looked like when this request was dispatched.
     *
     * The agent is told these values, not the live ones. A client who renames a
     * photo or moves it to another folder after sending a request has not
     * changed what they asked for, and the job must not silently acquire
     * different inputs because the library moved underneath it.
     */
    snapshotChecksum: text("snapshot_checksum"),
    snapshotTitle: text("snapshot_title"),
    snapshotDescription: text("snapshot_description"),
    snapshotFolderPath: text("snapshot_folder_path"),
    snapshotWidth: integer("snapshot_width"),
    snapshotHeight: integer("snapshot_height"),
    /** Set when the request is dispatched; null while it is still editable. */
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("request_assets_request_asset_key").on(t.requestId, t.assetId),
    index("request_assets_request_idx").on(t.requestId),
    index("request_assets_asset_idx").on(t.assetId),
  ],
);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Where an image ended up.
 *
 * Recorded from what the platform actually knows — which request carried an
 * asset, and whether that request reached the live site — rather than by
 * crawling the published HTML. That keeps every row here defensible: it is a
 * fact about our own pipeline, not a guess about a page.
 *
 * The consequence, stated plainly in the UI, is that an image placed on the
 * site outside the request flow will not appear here.
 */
export const mediaUsages = pgTable(
  "media_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    requestId: uuid("request_id").references(() => changeRequests.id, {
      onDelete: "set null",
    }),
    /** Human-readable location: a page path where known, otherwise the request. */
    location: text("location").notNull(),
    /** `pending` while the request is in flight, `published` once it is live. */
    state: text("state").notNull().default("pending"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_usages_asset_request_key").on(t.assetId, t.requestId),
    index("media_usages_asset_idx").on(t.assetId),
    check(
      "media_usages_state_valid",
      sql`${t.state} IN ('pending', 'published', 'removed')`,
    ),
  ],
);

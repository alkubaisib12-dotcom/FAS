# Asset IDs / Physical Tags — Do Not Change

## The rule

Every asset has an **Asset ID** (e.g. `DES-001`, `LAP-014`, `MON-007`). This value
is being printed onto a physical label and stuck onto the real device.

**Once an asset's tag has been printed and attached, its Asset ID must never be
changed, edited, regenerated, or reused for a different asset.**

This applies everywhere in the app and the database — the asset table, the
asset form, bulk-add/scan flows, ID generation (`/assets/next-id`,
`/assets/bulk-next-ids`), and any future features. If the printed tag and the
`assetId` in the system ever disagree, every report, search, and audit trail
becomes unreliable.

## Why this matters

- The Asset ID is the **only** link between the physical sticker on a device
  and the database record for it.
- Changing the ID after the tag is printed means either reprinting/relabeling
  the device (extra work) or having a mismatched tag forever (confusing,
  error-prone).
- Anything that "renames" an asset (the edit form currently allows changing
  `assetId`) should be treated as **high risk** once that asset has a physical
  tag — avoid it, and if it's unavoidable, the physical tag must be reprinted
  and re-applied to match.

## What this means for development

- Do **not** add features that bulk-rename, re-sequence, or auto-renumber
  existing Asset IDs.
- Do **not** repurpose an Asset ID from a deleted/retired asset for a new one
  if the old tag might still be lying around.
- Any UI that shows the Asset ID for an already-tagged asset should treat it
  as **read-only / reference-only** — see the Asset Labeling view below for
  the pattern.

## Tracking which assets are physically labeled

To help track which assets still need their physical tag printed and applied,
there is an **Asset Labeling** tab (toolbar button: "Asset Labeling").

- It shows the same asset list (with search and pagination) plus a simple
  **Labeled / Not labeled** checkbox per asset.
- A progress bar at the top shows how many assets are labeled vs. remaining.
- A "Show only unlabeled" filter makes it easy to work through what's left.
- Every field except the "Labeled" checkbox is **read-only** in this view —
  Asset IDs are shown for reference only and can't be edited here.

### How it works (for developers)

- New `labeled` column on the `assets` table (`0`/`1`, defaults to `0`),
  added via an automatic migration in `asset-manager-backend/index.js`.
- `PATCH /assets/:id/labeled` — the **only** endpoint that can change this
  flag. It updates a single column and nothing else.
- `GET /assets/label-stats` — returns `{ total, labeled, unlabeled }` for the
  progress bar.
- `GET /assets?labeled=0|1` — filters the asset list by labeling status.
- The `labeled` flag is **not** part of the regular asset edit form/payload
  (`ASSET_COLUMNS` / `sanitizeAssetPayload`), so saving an asset from the
  normal Add/Edit form can never touch it.
- If an asset's `assetId` is changed via the edit form (rename), its existing
  `labeled` value is preserved across the rename.

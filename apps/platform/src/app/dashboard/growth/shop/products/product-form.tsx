"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProductDetail } from "@/db/repositories/client/shop-products";
import { Uploader } from "../../../media/uploader";
import { createProductAction, updateProductAction, type ProductActionResult } from "./actions";

/**
 * One form for a new product and for changing one.
 *
 * Photos come from the media library, newest first, and new ones can be
 * uploaded right here through the library's own uploader. The order they
 * are ticked in is the order they show on the site, and the first is the
 * cover. The server checks everything; nothing here is trusted.
 */

export interface PickablePhoto {
  publicId: string;
  title: string;
  ready: boolean;
  hasThumbnail: boolean;
}

/** How long to wait before looking again for photos still being prepared. */
const PROCESSING_RECHECK_MS = 4000;

export function ProductForm({
  product,
  photos,
  maxPhotos,
  readOnly,
}: {
  /** Absent for a new product. */
  product?: ProductDetail;
  photos: PickablePhoto[];
  maxPhotos: number;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ProductActionResult | null, FormData>(
    product ? updateProductAction : createProductAction,
    null,
  );

  return (
    <form action={formAction} className="shop-product-form">
      {product && <input type="hidden" name="product" value={product.publicId} />}
      {/* Keyed on the save time so the fields start again from what the
          server now holds. React resets a form once its action has run,
          which unticks a controlled checkbox while the state says otherwise;
          a fresh mount makes the two agree. */}
      <Fields
        key={product?.updatedAt.getTime() ?? 0}
        product={product}
        photos={photos}
        maxPhotos={maxPhotos}
        readOnly={readOnly}
        disabled={readOnly || pending}
      />
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Saving…" : product ? "Save" : "Add product"}
      </button>
      {!product && <p className="hint">It goes on your website only when you put it there, so you can check it first.</p>}
    </form>
  );
}

function Fields({
  product,
  photos,
  maxPhotos,
  readOnly,
  disabled,
}: {
  product?: ProductDetail;
  photos: PickablePhoto[];
  maxPhotos: number;
  readOnly: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(product?.photos.map((p) => p.assetPublicId) ?? []);
  const [uploading, setUploading] = useState(false);

  const processing = photos.some((p) => !p.ready);
  useEffect(() => {
    if (!processing) return;
    const timer = setTimeout(() => router.refresh(), PROCESSING_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [processing, photos, router]);

  function toggle(publicId: string) {
    if (chosen.includes(publicId)) setChosen(chosen.filter((id) => id !== publicId));
    else if (chosen.length < maxPhotos) setChosen([...chosen, publicId]);
  }

  // A photo on the product that is no longer in the picker (trashed, or
  // older than the newest it shows) stays chosen until unticked here.
  const unlisted = chosen.filter((id) => !photos.some((p) => p.publicId === id));

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{product ? "Details" : "1. Details"}</h2>
        </div>
        <div className="panel-body">
          <label htmlFor="product-name">Name</label>
          <input id="product-name" name="name" required maxLength={120} defaultValue={product?.name ?? ""} disabled={disabled} placeholder="Small cast fish" />

          <div className="shop-product-fields">
            <div>
              <label htmlFor="product-price">Price</label>
              <div className="shop-money">
                <span aria-hidden="true">$</span>
                <input
                  id="product-price"
                  name="price"
                  inputMode="decimal"
                  required
                  defaultValue={product ? (product.priceCents / 100).toFixed(2) : ""}
                  disabled={disabled}
                  placeholder="150.00"
                />
              </div>
            </div>
            <div>
              <label htmlFor="product-stock">In stock</label>
              <input
                id="product-stock"
                name="stock"
                inputMode="numeric"
                defaultValue={product?.stock ?? ""}
                disabled={disabled}
                placeholder="Leave blank for unlimited"
              />
              <p className="field-hint">
                Units you have. The site stops selling at zero.
                {product && product.reserved > 0 ? ` ${product.reserved} held by customers in checkout right now.` : ""}
              </p>
            </div>
          </div>

          <label htmlFor="product-description">Description</label>
          <textarea
            id="product-description"
            name="description"
            rows={4}
            maxLength={2000}
            defaultValue={product?.description ?? ""}
            disabled={disabled}
            placeholder="Size, materials, what makes it this one. Shipping and returns are already on the page from your settings."
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{product ? "Photos" : "2. Photos"}</h2>
          <span className="panel-sub">
            {chosen.length === 0 ? `Up to ${maxPhotos}` : `${chosen.length} of ${maxPhotos}, first is the cover`}
          </span>
        </div>
        <div className="panel-body">
          {photos.length === 0 && !uploading ? (
            <p className="field-hint">No photos in your library yet. Upload some below.</p>
          ) : (
            <ul className="media-picker-grid shop-picker">
              {photos.map((photo) => {
                const index = chosen.indexOf(photo.publicId);
                const isChosen = index >= 0;
                return (
                  <li key={photo.publicId}>
                    <label className={`media-picker-tile${isChosen ? " is-selected" : ""}${photo.ready ? "" : " is-waiting"}`}>
                      <input
                        type="checkbox"
                        checked={isChosen}
                        disabled={!photo.ready || disabled}
                        onChange={() => toggle(photo.publicId)}
                        aria-label={photo.title}
                      />
                      {isChosen && (
                        <span className="shop-pick-order" aria-hidden="true">
                          {index + 1}
                        </span>
                      )}
                      {photo.hasThumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/assets/${photo.publicId}/thumb`} alt="" loading="lazy" />
                      ) : (
                        <span className="shop-pick-blank" aria-hidden="true" />
                      )}
                      <span title={photo.title}>{photo.ready ? photo.title : "Getting ready…"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {unlisted.length > 0 && (
            <p className="hint">
              {unlisted.length === 1 ? "One photo on this product is" : `${unlisted.length} photos on this product are`} not in the
              newest photos shown here. {readOnly ? "" : "They stay on the product unless you remove them: "}
              {!readOnly &&
                unlisted.map((id) => (
                  <button key={id} type="button" className="link-button" onClick={() => toggle(id)}>
                    remove {product?.photos.find((p) => p.assetPublicId === id)?.title ?? "photo"}
                  </button>
                ))}
            </p>
          )}

          {chosen.map((id) => (
            <input key={id} type="hidden" name="photo" value={id} />
          ))}

          {!readOnly && (
            <div className="shop-upload">
              {uploading ? (
                <Uploader folderPublicId={null} folderLabel="your library" onUploaded={() => router.refresh()} />
              ) : (
                <button type="button" className="secondary small" onClick={() => setUploading(true)}>
                  Upload new photos
                </button>
              )}
              <p className="hint">New photos go into your media library too.</p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

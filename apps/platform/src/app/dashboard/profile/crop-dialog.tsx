"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACCEPTED_TYPES,
  MAX_ZOOM,
  MIN_ZOOM,
  OUTPUT_EDGE,
  cropRect,
  initialCrop,
  panCrop,
  previewStyle,
  zoomCrop,
  type Crop,
  type ImageSize,
} from "./crop";

/**
 * The new picture, in its circle, before it is saved.
 *
 * A native modal `<dialog>`: the browser keeps focus inside it, makes the
 * page behind inert, closes it on Esc and hands focus back to the avatar
 * button afterwards. The photo is dragged (pointer or arrow keys) and zoomed
 * (slider, or + and -), and what is saved is cut from the original in the
 * browser — a 512-pixel square, a few dozen kilobytes however large the
 * photo was. The server checks and re-encodes it like any other upload.
 */

/** Screen pixels an arrow key moves the photo. */
const KEY_STEP = 12;
/** How much one + or - press zooms. */
const KEY_ZOOM = 0.25;
/** Steps on the zoom slider: fine enough to feel continuous. */
const ZOOM_STEP = 0.01;
const ENCODE_QUALITY = 0.9;

const UNREADABLE = "That image couldn't be read. Try another photo.";

interface CropDialogProps {
  /** An object URL of the chosen file; the caller makes it and revokes it. */
  src: string;
  saving: boolean;
  /** Why the last save failed, from the server. */
  error: string | null;
  onSave: (picture: Blob) => void;
  onCancel: () => void;
  /** Swap in another file; returns why it cannot be used, or null. */
  onChooseAnother: (file: File) => string | null;
  /** Where focus goes when the dialog closes. */
  returnFocusTo: React.RefObject<HTMLElement | null>;
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, ENCODE_QUALITY));
}

/** Cut the crop out of the photo, on white so a transparent PNG does not save black. */
async function render(img: HTMLImageElement, image: ImageSize, crop: Crop): Promise<Blob | null> {
  const rect = cropRect(image, crop);
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_EDGE;
  canvas.height = OUTPUT_EDGE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, OUTPUT_EDGE, OUTPUT_EDGE);
  context.imageSmoothingQuality = "high";
  context.drawImage(img, rect.x, rect.y, rect.size, rect.size, 0, 0, OUTPUT_EDGE, OUTPUT_EDGE);
  // WebP where the browser can write it (Safari before 17 cannot, and
  // quietly hands back a PNG); JPEG otherwise.
  const webp = await encode(canvas, "image/webp");
  if (webp?.type === "image/webp") return webp;
  return encode(canvas, "image/jpeg");
}

export function CropDialog({ src, saving, error, onSave, onCancel, onChooseAnother, returnFocusTo }: CropDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const anotherRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const [image, setImage] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  // The avatar button gets focus back when the dialog goes, saved or
  // cancelled — named, not "whatever had focus", because Safari does not
  // focus a button on click and the file picker leaves focus nowhere.
  useEffect(() => {
    const returnTo = returnFocusTo.current;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => returnTo?.focus();
  }, [returnFocusTo]);

  const busy = saving || preparing;

  function loaded(event: React.SyntheticEvent<HTMLImageElement>) {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (!width || !height) {
      setProblem(UNREADABLE);
      return;
    }
    const size = { width, height };
    setImage(size);
    setCrop(initialCrop(size));
    setProblem(null);
  }

  function pan(dx: number, dy: number) {
    const viewport = frameRef.current?.clientWidth;
    if (!image || !viewport) return;
    setCrop((current) => (current ? panCrop(image, current, dx, dy, viewport) : current));
  }

  function zoomTo(zoom: number) {
    if (!image) return;
    setCrop((current) => (current ? zoomCrop(image, current, zoom) : current));
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!image || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const from = dragFrom.current;
    if (!from) return;
    pan(event.clientX - from.x, event.clientY - from.y);
    dragFrom.current = { x: event.clientX, y: event.clientY };
  }

  function endDrag() {
    dragFrom.current = null;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!crop || busy) return;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [KEY_STEP, 0],
      ArrowRight: [-KEY_STEP, 0],
      ArrowUp: [0, KEY_STEP],
      ArrowDown: [0, -KEY_STEP],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      pan(move[0], move[1]);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(crop.zoom + KEY_ZOOM);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomTo(crop.zoom - KEY_ZOOM);
    }
  }

  async function save() {
    const img = imgRef.current;
    if (!img || !image || !crop) return;
    setPreparing(true);
    try {
      const picture = await render(img, image, crop);
      if (!picture) {
        setProblem("Your photo couldn't be prepared in this browser. Try another photo.");
        return;
      }
      setProblem(null);
      onSave(picture);
    } catch {
      setProblem(UNREADABLE);
    } finally {
      setPreparing(false);
    }
  }

  function chooseAnother(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const refused = onChooseAnother(file);
    setProblem(refused);
    if (refused) return;
    setImage(null);
    setCrop(null);
  }

  const style = image && crop ? previewStyle(image, crop) : null;
  const message = problem ?? error;

  return (
    <dialog
      ref={dialogRef}
      className="crop-dialog"
      aria-labelledby="crop-title"
      aria-describedby="crop-help"
      // Esc, or the browser's own close: the same as Cancel, except mid-save.
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="crop-dialog-head">
        <h2 id="crop-title">Position your photo</h2>
        <p id="crop-help">Drag the photo to move it, and zoom with the slider. The circle is what people see.</p>
      </div>

      <div
        ref={frameRef}
        className={`crop-frame${image ? "" : " is-loading"}`}
        role="group"
        aria-label="Photo position. Arrow keys move it; plus and minus zoom."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL being cropped; next/image cannot load it. */}
        <img
          key={src}
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={loaded}
          onError={() => setProblem(UNREADABLE)}
          style={style ?? { visibility: "hidden" }}
        />
        {!image && !problem && <span className="crop-frame-wait">Opening your photo…</span>}
      </div>

      <div className="crop-zoom">
        <label htmlFor="crop-zoom" className="sr-only">
          Zoom
        </label>
        <span aria-hidden="true">−</span>
        <input
          id="crop-zoom"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={ZOOM_STEP}
          value={crop?.zoom ?? MIN_ZOOM}
          onChange={(event) => zoomTo(Number(event.target.value))}
          disabled={!crop || busy}
        />
        <span aria-hidden="true">+</span>
      </div>

      {message && (
        <p className="error crop-error" role="alert">
          {message}
        </p>
      )}

      <div className="crop-actions">
        <button
          type="button"
          className="linklike crop-another"
          onClick={() => anotherRef.current?.click()}
          disabled={busy}
        >
          Choose another
        </button>
        <input
          ref={anotherRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={chooseAnother}
        />
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={!crop || busy}>
          {busy ? "Saving…" : "Save photo"}
        </button>
      </div>
    </dialog>
  );
}

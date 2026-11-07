import type { EpubReaderView } from "../shared/contracts";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type {
  EpubBridgeError,
  EpubPageLocation,
  EpubPreparedUnit,
  EpubReadyInfo,
  EpubRelocation,
  EpubSelection,
} from "./epub-bridge";
import type { TypstAsset } from "./typst";

/**
 * The messages between the reader page (`EpubBridgeClient`) and the sandboxed
 * viewer iframe. Both sides are bundled from this repository and share an
 * origin, so the types are the only schema. Type-only: the iframe bundle must
 * not pull anything from here at runtime.
 *
 * Every message after the handshake carries the `generation` of the book it
 * belongs to. `open` starts a new generation; the viewer drops requests of an
 * older one and the client drops replies of an older one.
 */

/** What a request can fail with. `EPUB_OPEN_FAILED` only ever ends an `open`. */
export type EpubFailureCode = EpubBridgeError["code"] | "EPUB_OPEN_FAILED";

export type EpubRequest =
  | { op: "prepare"; sourceCfi: string; layout: EpubLayoutSnapshot | null }
  | { op: "assets"; sourceCfi: string }
  | { op: "pages"; sectionIndexes: number[]; layout: EpubLayoutSnapshot }
  | { op: "display"; target: string | number }
  | { op: "next" }
  | { op: "prev" }
  | { op: "setView"; view: EpubReaderView };

/** What a request's `reply` carries; `pages` has no reply, it streams `page` messages and ends with `done`. */
export interface EpubReplies {
  prepare: EpubPreparedUnit;
  assets: readonly TypstAsset[];
  display: undefined;
  next: undefined;
  prev: undefined;
  setView: undefined;
}

export type ParentMessage =
  /** The iframe finished loading; it answers with `viewer-ready`. */
  | { type: "hello" }
  /** Starts generation `generation`; `bytes` is transferred. The viewer answers `ready` and does not display anything yet. */
  | { type: "open"; generation: number; bytes: ArrayBuffer }
  | { type: "request"; generation: number; id: number; request: EpubRequest }
  /** Stop the work of request `id`; no reply is expected for it. */
  | { type: "cancel"; generation: number; id: number }
  /** `pages` only: the consumer took the last `page`, so the viewer may measure the next one. */
  | { type: "ack"; generation: number; id: number }
  | { type: "clear-selection"; generation: number };

export type ViewerMessage =
  /** The iframe script is running and can take `open`. Posted on load and again on every `hello`. */
  | { type: "viewer-ready" }
  | { type: "ready"; generation: number; info: EpubReadyInfo }
  /** Always posted before the `reply` of the display, next, prev or setView that caused it. */
  | { type: "relocated"; generation: number; relocation: EpubRelocation }
  | { type: "selection"; generation: number; selection: EpubSelection | null }
  | { type: "reply"; generation: number; id: number; result: EpubReplies[keyof EpubReplies] }
  | { type: "page"; generation: number; id: number; page: EpubPageLocation }
  | { type: "done"; generation: number; id: number }
  /** `id` null: the book itself failed (`open`), not one request. */
  | { type: "failure"; generation: number; id: number | null; code: EpubFailureCode; message: string };

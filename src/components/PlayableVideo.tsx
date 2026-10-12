import { forwardRef, useEffect, useState, type VideoHTMLAttributes } from "react";
import { cmd } from "../lib/tauri";
import { fileSrc } from "../lib/assets";
import { getConfigCached } from "../lib/metadataCache";

// original path -> proxy path (null = tried, none available). Promises are
// memoised so N players on one file share a single transcode.
const pending = new Map<string, Promise<string | null>>();
const known = new Map<string, string>();

/** H.264 proxy for a video the webview can't decode, transcoded on first call
 *  into the user cache dir. Null when ffmpeg is missing or the transcode failed. */
export function ensureVideoProxy(path: string): Promise<string | null> {
  let p = pending.get(path);
  if (!p) {
    p = (async () => {
      const cfg = await getConfigCached();
      const out = await cmd.video_proxy_ensure(path, (cfg?.ffmpegPath ?? "").trim());
      if (out) known.set(path, out);
      return out;
    })().catch(() => null);
    pending.set(path, p);
  }
  return p;
}

/** The proxy for `path` if one has already been made, else the path itself.
 *  Sync, for callers (frame grabs) that must not trigger a transcode. */
export function playablePath(path: string): string {
  return known.get(path) ?? path;
}

type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & {
  /** Absolute path of the original file. */
  path: string | undefined;
};

/** `<video>` that falls back to a cached H.264 proxy when the original won't
 *  decode (HEVC 10-bit / 4:4:4 in WebView2). The original stays the master;
 *  only playback is redirected. */
export const PlayableVideo = forwardRef<HTMLVideoElement, Props>(function PlayableVideo(
  { path, onError, ...rest },
  ref,
) {
  const [proxied, setProxied] = useState<{ for: string; src: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // A new file starts from its original again.
  useEffect(() => {
    setBusy(false);
  }, [path]);

  const proxy = proxied && proxied.for === path ? proxied.src : null;
  const src = path ? (proxy ?? fileSrc(playablePath(path))) : undefined;

  return (
    <>
      <video
        {...rest}
        ref={ref}
        src={src}
        onError={(e) => {
          onError?.(e);
          if (!path || proxy || busy) return;
          setBusy(true);
          const forPath = path;
          void ensureVideoProxy(forPath).then((out) => {
            if (out) setProxied({ for: forPath, src: fileSrc(out) });
            setBusy(false);
          });
        }}
      />
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs opacity-80">
          Converting for playback…
        </div>
      )}
    </>
  );
});

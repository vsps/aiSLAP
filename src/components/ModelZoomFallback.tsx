import { FullscreenModal } from "./FullscreenModal";

type Props = {
  filename: string;
  onClose: () => void;
  /** Present only on the failure variant. */
  error?: string;
  onRetry?: () => void;
};

/**
 * Stand-in chrome for the lazily-loaded 3D viewer: same `FullscreenModal` shell
 * and toolbar geometry, so the real viewer swaps in without the panel jumping.
 *
 * The 3D stack is a large chunk. Rendering nothing while it loads makes a
 * double-click on a `.glb` look like it did nothing at all, so this always
 * paints something.
 */
export function ModelZoomFallback({
  filename,
  onClose,
  error,
  onRetry,
}: Props) {
  return (
    <FullscreenModal
      onClose={onClose}
      z={40}
      backgroundClassName="bg-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex items-center gap-2 px-3 py-1 bg-panel shrink-0">
        <span className="font-mono text-xs text-dim truncate flex-1">
          {filename}
        </span>
        <button
          className="accent-hover px-2 py-1 text-xs font-mono"
          title="Close (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center">
        {error ? (
          <div className="text-center font-mono text-xs">
            <div className="text-bad mb-2">3D viewer failed to load</div>
            <div className="text-dim mb-3 max-w-md break-words">{error}</div>
            {onRetry && (
              <button className="accent-hover px-3 py-1" onClick={onRetry}>
                retry
              </button>
            )}
          </div>
        ) : (
          <div className="font-mono text-xs text-dim animate-pulse">
            loading 3D viewer…
          </div>
        )}
      </div>
    </FullscreenModal>
  );
}

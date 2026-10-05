/**
 * Orca exports ORCA_IMAGE_PROTOCOL=kitty; Pi detects PI_IMAGE_PROTOCOL instead.
 * Set the Pi hint before the interactive TUI is constructed (its image mode is
 * captured at startup), without overriding an explicit user choice or tmux.
 */
export function enableOrcaKittyImages(): void {
  const term = process.env.TERM?.toLowerCase() ?? "";
  if (
    process.env.TERM_PROGRAM?.toLowerCase() === "orca" &&
    process.env.ORCA_IMAGE_PROTOCOL === "kitty" &&
    process.env.PI_IMAGE_PROTOCOL === undefined &&
    !process.env.TMUX &&
    !term.startsWith("tmux") &&
    !term.startsWith("screen")
  ) {
    process.env.PI_IMAGE_PROTOCOL = "kitty";
  }
}

// Extension modules load before the TUI is constructed. Calling this only in
// the registration callback is too late: Pi latches the image mode on startup.
enableOrcaKittyImages();
export default function orcaKittyImages(): void {}

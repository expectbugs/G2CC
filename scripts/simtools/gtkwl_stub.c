/* No-op stub for gdk_wayland_window_get_wl_surface.
 *
 * The EvenHub simulator (a Tauri/GTK3 binary) hard-references this GDK-Wayland symbol, which is
 * absent on a no-Wayland (X11-only) GTK build like this box. The symbol is only ever called on the
 * Wayland window path, which we never take (we force GDK_BACKEND=x11), so returning NULL satisfies
 * the dynamic linker with zero behavioural effect.
 *
 * Build:  gcc -shared -fPIC -O2 -o gtkwl_stub.so gtkwl_stub.c
 * Use:    GDK_BACKEND=x11 LD_PRELOAD=.../gtkwl_stub.so DISPLAY=:0.0 <evenhub-simulator ...>
 * Reversible (just an LD_PRELOAD); kept here (not /tmp) so it survives reboots.
 */
void *gdk_wayland_window_get_wl_surface(void *window) { return (void *)0; }

import { Platform } from 'obsidian';

/** Elements a tap on which gets a haptic tick: buttons, links, and tappable rows. */
export const TAPPABLE = "button, a, [role='button'], .clickable-icon, li.cook-ingredient";

/** A very short, subtle tap on phones and tablets (Obsidian routes navigator.vibrate to the device's haptics). */
export function hapticTap(enabled: boolean): void {
    if (enabled && Platform.isMobile) navigator.vibrate?.(10);
}

import type { ReactElement, ReactNode } from "react";
import { CLASS, cx } from "../internal/class-names.js";
import { Icon } from "../internal/icon.js";
import { TONE_CLASS, assertTone } from "../internal/tone.js";
import type { Tone } from "../internal/tone.js";

export type { Tone } from "../internal/tone.js";

export interface StatusBadgeProps {
  readonly tone: Tone;
  /** The status in words. A badge is never a colour or an icon alone. */
  readonly children: ReactNode;
}

/** StatusBadge (D-DS-1): a status as an icon plus text on a tinted surface; colour is never the only signal. */
export function StatusBadge({ tone, children }: StatusBadgeProps): ReactElement {
  assertTone(tone);
  return (
    <span className={cx(CLASS.statusBadge, TONE_CLASS[tone])}>
      <Icon name={tone} />
      <span>{children}</span>
    </span>
  );
}

export interface BannerProps {
  readonly tone: Tone;
  readonly title?: string | undefined;
  /**
   * How a change of the banner is announced. "status" is polite, "alert" is assertive, "none" (the default) is silent, for a
   * banner that is simply part of the page. One announcement per durable change (D-A11Y-1): the caller renders the banner
   * when the change happens and removes it when it stops being true.
   */
  readonly announce?: "status" | "alert" | "none" | undefined;
  readonly children: ReactNode;
}

/** Banner (D-DS-1): a message that concerns the whole page or section, with an icon, an optional title and a tone. */
export function Banner({ tone, title, announce = "none", children }: BannerProps): ReactElement {
  assertTone(tone);
  return (
    <div className={cx(CLASS.banner, TONE_CLASS[tone])} role={announce === "none" ? undefined : announce}>
      <Icon name={tone} />
      <div className={CLASS.bannerBody}>
        {title === undefined ? null : <p className={CLASS.bannerTitle}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

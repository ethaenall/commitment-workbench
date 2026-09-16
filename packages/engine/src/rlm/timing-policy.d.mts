// SPDX-License-Identifier: AGPL-3.0-only
import type { BindingTiming } from "./binding-protocol.js";
export const TIMING_CEILINGS: Readonly<BindingTiming>;
export function lowerTiming(value?: Readonly<Partial<BindingTiming>> | Readonly<Record<string, unknown>>): Readonly<BindingTiming>;

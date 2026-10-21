"use client";

import { useActionState, useState } from "react";
import {
  AD_CHANNELS,
  AD_DURATIONS_DAYS,
  AD_MANAGEMENT_FEE,
  channelMinimumCents,
  channelSuggestedCents,
  dollars,
  type AdChannelKey,
} from "@mortensenweb/plans";
import { CheckoutLinesTable } from "@/components/ads/checkout-lines";
import { checkoutLines } from "@/lib/ads/money";
import { saveChannelsAction, type ChannelsState } from "../../actions";

/**
 * Where the ad runs and what each place gets.
 *
 * The running total is the same calculation checkout uses, with the fee as a
 * line of its own, so the client sees what they will be charged while they
 * are still deciding — not for the first time on Stripe's page.
 */
export function ChannelPicker({
  campaign,
  initial,
  readOnly,
}: {
  campaign: string;
  initial: { channels: Array<{ channel: AdChannelKey; budgetCents: number }>; days: number; startsOn: string; earliest: string };
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ChannelsState, FormData>(saveChannelsAction, null);
  const [days, setDays] = useState(initial.days);
  const [chosen, setChosen] = useState<Set<AdChannelKey>>(new Set(initial.channels.map((c) => c.channel)));
  const [budgets, setBudgets] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      AD_CHANNELS.map((c) => {
        const saved = initial.channels.find((x) => x.channel === c.key);
        const cents = saved?.budgetCents ?? channelSuggestedCents(c, initial.days);
        return [c.key, String(Math.round(cents / 100))];
      }),
    ),
  );

  const selected = AD_CHANNELS.filter((c) => chosen.has(c.key)).map((c) => ({
    channel: c.key,
    budgetCents: Math.max(0, Math.round(Number(budgets[c.key] || 0) * 100)),
  }));
  const lines = checkoutLines({ channels: selected, terms: AD_MANAGEMENT_FEE });
  const errors = state?.errors ?? {};

  function toggle(key: AdChannelKey) {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChosen(next);
  }

  return (
    <form action={formAction} className="ad-channels">
      <input type="hidden" name="campaign" value={campaign} />

      <fieldset className="ad-channels-list" disabled={readOnly || pending}>
        <legend>Where it runs</legend>
        {AD_CHANNELS.map((channel) => {
          const on = chosen.has(channel.key);
          const minimum = channelMinimumCents(channel, days);
          const suggested = channelSuggestedCents(channel, days);
          const budgetCents = Math.round(Number(budgets[channel.key] || 0) * 100);
          const low = on && budgetCents < minimum;
          return (
            <div key={channel.key} className="ad-channel" data-on={on || undefined}>
              <label className="checkbox ad-channel-head">
                <input
                  type="checkbox"
                  name="channel"
                  value={channel.key}
                  checked={on}
                  onChange={() => toggle(channel.key)}
                />
                <span>
                  <strong>{channel.name}</strong>
                  <small>{channel.platform === "meta" ? "Meta" : "Google Ads"}</small>
                </span>
              </label>
              <p className="ad-channel-summary">{channel.summary}</p>
              {channel.needs && <p className="field-hint">Needs: {channel.needs}</p>}
              <dl className="ad-channel-facts">
                <div>
                  <dt>Minimum</dt>
                  <dd>{dollars(minimum)}</dd>
                </div>
                <div>
                  <dt>Suggested</dt>
                  <dd>{dollars(suggested)}</dd>
                </div>
                <div>
                  <dt>We suggest</dt>
                  <dd>{channel.suggestedDays} days</dd>
                </div>
              </dl>
              <label htmlFor={`budget-${channel.key}`}>Budget for {channel.name}</label>
              <div className="ad-money-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`budget-${channel.key}`}
                  name={`budget_${channel.key}`}
                  inputMode="numeric"
                  value={budgets[channel.key]}
                  disabled={!on}
                  aria-invalid={low || Boolean(errors[channel.key]) || undefined}
                  onChange={(e) => setBudgets({ ...budgets, [channel.key]: e.target.value.replace(/[^\d]/g, "") })}
                />
                {on && budgetCents !== suggested && (
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setBudgets({ ...budgets, [channel.key]: String(suggested / 100) })}
                  >
                    Use {dollars(suggested)}
                  </button>
                )}
              </div>
              {(errors[channel.key] || low) && (
                <p className="error">{errors[channel.key] ?? `At least ${dollars(minimum)} for ${days} days.`}</p>
              )}
            </div>
          );
        })}
      </fieldset>

      <aside className="ad-channels-side">
        <fieldset disabled={readOnly || pending}>
          <legend>When</legend>
          <label htmlFor="ad-days">How long it runs</label>
          <select id="ad-days" name="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {AD_DURATIONS_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <label htmlFor="ad-start">Start no earlier than</label>
          <input id="ad-start" name="startsOn" type="date" min={initial.earliest} defaultValue={initial.startsOn} />
          <p className="field-hint">
            We check every ad before it runs. If that takes longer than your start date allows, both dates move
            together, so you still get every day you paid for.
          </p>
          {errors.startsOn && <p className="error">{errors.startsOn}</p>}
        </fieldset>

        <h3>So far</h3>
        {selected.length > 0 ? (
          <CheckoutLinesTable lines={lines} />
        ) : (
          <p className="muted">Choose at least one place for your ad to run.</p>
        )}
        <p className="field-hint">
          Ad spend goes to Google or Meta at cost. The management fee is ours, for setting up, checking and running
          the campaign.
        </p>
        {errors.form && <p className="error">{errors.form}</p>}

        <button type="submit" disabled={readOnly || pending || selected.length === 0}>
          {pending ? "Saving…" : "Review and pay"}
        </button>
      </aside>
    </form>
  );
}

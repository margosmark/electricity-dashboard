/**
 * Wave N — the push topic table, from the client's point of view.
 *
 * The labels are CONTENT (what the topic is about), never channel names, so
 * they can be shared by anything that has to talk about a topic:
 * `NotificationSettings` renders them, and `useRefreshNotices` asks
 * `topicHasProducer()` before it lets push and an on-device alert both fire
 * for the same event.
 *
 * `TOPICS_WITHOUT_PRODUCER` is the honest half of that contract: a checkbox
 * that can never fire is worse than a missing one, so those rows are rendered
 * disabled + checked with the reason printed underneath, and the dedup guard
 * keeps treating them as "nothing will push this". Drop an entry the moment
 * its producer lands — do NOT delete the row, which would change the prefs a
 * user has already saved.
 */

export const TOPIC_LABELS: Record<string, string> = {
  plan_change: "A cheaper plan appears for your usage",
  oeb_rates: "New Ontario rates are published",
  data_available: "Your utility posted new data",
  anomaly: "An unusually expensive day is detected",
};

export const MIN_INTERVAL_TEXT: Record<string, string> = {
  plan_change: "at most once a day",
  oeb_rates: "at most once a week",
  data_available: "at most once a day",
  anomaly: "at most once a day",
};

/**
 * Topics with no emitter yet.
 *
 * `plan_change` is Wave M's detector, which derives a banner (and an
 * on-device alert) but never asks the account server to push — that producer
 * is a separate card. Every other topic has one today: `anomaly` from
 * `AccountTriggers`, `oeb_rates` from `services.ts`, `data_available` from
 * the shim's webhook.
 */
const TOPICS_WITHOUT_PRODUCER = new Set(["plan_change"]);

/** Can this topic actually reach a closed tab today? */
export function topicHasProducer(topic: string): boolean {
  return !TOPICS_WITHOUT_PRODUCER.has(topic);
}

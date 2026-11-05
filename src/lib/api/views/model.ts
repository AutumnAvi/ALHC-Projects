// Big move 1: the views area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).


export type MetricBucket = { bucket: string | null; count: number };

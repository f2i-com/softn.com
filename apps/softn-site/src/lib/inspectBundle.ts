/**
 * Bundle inspection for the publish page, from the shared bundle contract
 * (@softn/bundle-format): the same checks core applies, so what the drop zone
 * accepts is what the runtime will open. The local type names are kept for
 * the page that uses them.
 */
export { inspectBundle, inspectEntries } from '@softn/bundle-format/inspect';
export type { BundleInspection as Inspection, BundleReportLine as ReportLine } from '@softn/bundle-format/inspect';

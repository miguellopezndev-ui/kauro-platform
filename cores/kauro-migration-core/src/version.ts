/**
 * The core version.
 *
 * Declared here rather than read from package.json so that a run does not
 * depend on file layout at runtime. A test asserts the two stay equal.
 */
export const CORE_VERSION = '3.0.0';

/** Version of the artifact package layout. Changing an artifact's columns changes this. */
export const PACKAGE_FORMAT_VERSION = '2.1.0';

/**
 * Date the destination documentation in docs/SOURCE_REGISTRY.md was last
 * reviewed. Recorded in every manifest so a package states which vendor
 * baseline it was produced against.
 */
export const SOURCE_REGISTRY_VERSION = '2026-09-06';

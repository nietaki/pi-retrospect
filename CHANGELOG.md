# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-09

### Added

- Restrict session discovery and transcript reads to projects allowed by the
  `piRetrospect.allowedProjects` setting.

### Changed

- Require Node.js 24 or newer.

## [0.3.0] - 2026-10-07

### Added

- Add an operational skill for agents using pi-retrospect.
- Add steering-message markers to transcript entries.

### Changed

- Exclude the current session from session discovery by default.

## [0.2.0] - 2026-10-07

### Added

- Read session transcripts with line addressing, filters, literal text search,
  and a text-only projection.
- Stream transcript files so large sessions can be read without loading the
  entire file into memory.

## [0.1.0] - 2026-10-02

### Added

- Initial release with session discovery and browsing, including session
  metadata and summaries.

[Unreleased]: https://github.com/nietaki/pi-retrospect/compare/v0.4.0...master
[0.4.0]: https://github.com/nietaki/pi-retrospect/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nietaki/pi-retrospect/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nietaki/pi-retrospect/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nietaki/pi-retrospect/releases/tag/v0.1.0

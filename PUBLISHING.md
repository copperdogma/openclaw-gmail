# Publishing Notes — openclaw-gmail

## Recommended release path (phase it)
1) **GitHub first** (done)
2) **npm later** once OpenClaw’s schema validation for channel plugins is relaxed

## GitHub release checklist
- [ ] Tag a release (`v0.1.0`)
- [ ] Attach release notes from CHANGELOG
- [ ] Add installation instructions (README already has)

## npm publish (when ready)
```bash
npm login
npm publish --access public
```

Validate package contents beforehand:
```bash
npm pack
```

## Announce
- OpenClaw Discord (plugins / extensions channel)
- GitHub Discussions (openclaw/openclaw)
- ClawHub (if/when plugin registry supports channels)

## Known limitation
OpenClaw’s strict config schema can reject npm‑installed channel plugins. Workaround: copy into `extensions/`.

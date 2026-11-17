# 0011: The brains listen a hundred above full Chronos's

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Lite's three llama-servers listen on 7710 (9B), 7720 (4B) and 7730 (0.8B), full Chronos's own ports plus 100. `scripts/check-edition.mjs` holds every brain to a port of its own in 77xx that is not the service's.

## Why

The brains' entries were taken from Chronos's catalogue with their ports. Left as they were, a Lite started beside a running full Chronos would find 7610, 7620 or 7630 taken, and the brains module refuses a port another server answers on. Found while carving, before anything ran.

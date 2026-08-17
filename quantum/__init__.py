"""Constraint-preserving ansaetze on all-to-all trapped-ion hardware.

Two modules:

* :mod:`quantum.dicke_xy` — the primitives. Baertschi-Eidenbenz Dicke state
  preparation and the XY-ring mixer, expressed once in a backend-free gate IR
  and materialised into pytket (Quantinuum) circuits. Ships its own dense
  reference simulator so the *construction* can be verified with numpy alone,
  before any SDK is trusted.
* :mod:`quantum.characterise` — the (n, k) sweep harness that measures
  fidelity, compiled cost on three connectivity graphs, in-constraint
  probability under noise, and an HQC cost proxy, and writes a report in which
  every number is labelled measured / estimated / NOT RUN.

Optionally :mod:`quantum.selene_backend`, which emits Guppy for Quantinuum's
Selene emulator. It is imported lazily and never required.

Nothing here imports pytket, qiskit, guppy or selene at module scope. The pure
numpy core is always importable, and that is the part the test suite pins.
"""

from __future__ import annotations

__all__ = ["dicke_xy", "characterise", "selene_backend"]

"""Friendly recovery screen for a missing Green Button XML export.

``electricit2024-now.xml`` is gitignored on purpose (size + personal energy data),
so a fresh clone of this repo has no data file. Instead of a dead-end red
``Error loading data: [Errno 2] ...`` box, the dashboard explains what file it
wants, where to get it, why it is not in git, and offers the bundled sample data
so the UI stays demoable without the real export.

The copy lives in :func:`recovery_copy` (pure, unit-testable); the rendering
lives in :func:`render_recovery_screen`.
"""

import streamlit as st

EXPECTED_XML_FILENAME = "electricit2024-now.xml"
SAMPLE_BUTTON_LABEL = "🧛 Use bundled sample data"


def recovery_copy(error=None):
    """The full recovery message, as plain strings so tests can assert on it."""
    technical = "" if error is None else f"{type(error).__name__}: {error}"
    return {
        "title": "📂 No energy data file found",
        "missing_file": (
            f"This dashboard needs **`{EXPECTED_XML_FILENAME}`** (saved next to `app.py`) "
            "to show your usage, and that file is not here."
        ),
        "how_to_get": (
            "**Where to get it:** log in to your **Oakville Hydro** account and use the "
            "**Green Button / Download My Data** export. Pick the **XML (ESPI)** format "
            f"covering Jan 2024 to now, save it next to `app.py` as "
            f"**`{EXPECTED_XML_FILENAME}`**, then refresh this page."
        ),
        "why_not_in_git": (
            "**Why it is not in the repo:** `.gitignore` deliberately excludes `*.xml`. "
            "Green Button exports are multi-megabyte and reveal personal patterns "
            "(when you are home, your sleep schedule, when you are on vacation), so your "
            "energy data is treated as PII and is never committed."
        ),
        "demo_offer": (
            "**Just exploring?** Load the bundled sample data instead - a small inline "
            "5-day fixture that exercises every chart, no real export needed."
        ),
        "button_label": SAMPLE_BUTTON_LABEL,
        "technical": technical,
    }


def render_recovery_screen(error=None):
    """Render the recovery screen. Returns True if the user chose sample data."""
    copy = recovery_copy(error)

    st.subheader(copy["title"])
    st.markdown(copy["missing_file"])
    st.markdown(copy["how_to_get"])
    st.markdown(copy["why_not_in_git"])
    st.markdown(copy["demo_offer"])

    use_sample = st.button(
        copy["button_label"],
        type="primary",
        key="use_bundled_sample_data",
        help="Loads a 5-day inline sample fixture instead of your real export.",
    )

    if copy["technical"]:
        with st.expander("Technical details"):
            st.code(copy["technical"])

    return use_sample

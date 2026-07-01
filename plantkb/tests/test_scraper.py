from __future__ import annotations

from agronomy_pipeline.scraper import html_to_text


def test_html_to_text_removes_scripts_and_collapses_whitespace() -> None:
    html = """
    <html>
      <head><style>.hidden { display: none; }</style></head>
      <body>
        <h1>Late blight</h1>
        <script>alert("ignore")</script>
        <p>Symptoms: water-soaked spots.</p>
      </body>
    </html>
    """

    assert html_to_text(html) == "Late blight Symptoms: water-soaked spots."

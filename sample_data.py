"""Bundled sample Green Button data so the dashboard is demoable without the real export.

The real file (``electricit2024-now.xml``) is gitignored -- it is large and contains
personal energy data -- so a fresh clone hits the missing-XML path in ``app.py``.
This module ships a small *inline* truncated XML fixture (5 days of hourly readings,
2024-07-06..2024-07-10: weekend + weekdays, one 1-hour outage dip) and pushes it
through the very same :func:`parser.parse_green_button_xml` the real file uses, so
every chart behaves exactly as it would with real data.

The inline-``SAMPLE_XML`` pattern is the one already proven in ``tests/test_parser.py``.
"""

import os
import tempfile

from parser import parse_green_button_xml

SAMPLE_XML_FILENAME = "bundled sample fixture (5 days, 2024-07-06..2024-07-10)"

# Truncated Green Button / ESPI feed: 120 hourly IntervalReadings (5 days).
# Hours are America/Toronto local (EDT, UTC-4); values are Wh, as Oakville Hydro exports them.
SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<!-- Bundled SAMPLE fixture: 5 days (2024-07-06..2024-07-10) of hourly readings.
     Truncated stand-in for electricit2024-now.xml (gitignored, see .gitignore). -->
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry>
    <espi:IntervalBlock>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720238400</espi:start></espi:timePeriod><espi:value>165</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720242000</espi:start></espi:timePeriod><espi:value>190</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720245600</espi:start></espi:timePeriod><espi:value>215</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720249200</espi:start></espi:timePeriod><espi:value>179</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720252800</espi:start></espi:timePeriod><espi:value>214</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720256400</espi:start></espi:timePeriod><espi:value>188</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720260000</espi:start></espi:timePeriod><espi:value>228</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720263600</espi:start></espi:timePeriod><espi:value>242</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720267200</espi:start></espi:timePeriod><espi:value>532</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720270800</espi:start></espi:timePeriod><espi:value>616</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720274400</espi:start></espi:timePeriod><espi:value>426</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720278000</espi:start></espi:timePeriod><espi:value>450</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720281600</espi:start></espi:timePeriod><espi:value>360</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720285200</espi:start></espi:timePeriod><espi:value>330</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720288800</espi:start></espi:timePeriod><espi:value>274</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720292400</espi:start></espi:timePeriod><espi:value>334</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720296000</espi:start></espi:timePeriod><espi:value>438</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720299600</espi:start></espi:timePeriod><espi:value>778</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720303200</espi:start></espi:timePeriod><espi:value>962</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720306800</espi:start></espi:timePeriod><espi:value>882</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720310400</espi:start></espi:timePeriod><espi:value>616</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720314000</espi:start></espi:timePeriod><espi:value>436</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720317600</espi:start></espi:timePeriod><espi:value>270</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720321200</espi:start></espi:timePeriod><espi:value>230</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720324800</espi:start></espi:timePeriod><espi:value>207</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720328400</espi:start></espi:timePeriod><espi:value>166</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720332000</espi:start></espi:timePeriod><espi:value>191</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720335600</espi:start></espi:timePeriod><espi:value>155</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720339200</espi:start></espi:timePeriod><espi:value>90</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720342800</espi:start></espi:timePeriod><espi:value>230</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720346400</espi:start></espi:timePeriod><espi:value>204</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720350000</espi:start></espi:timePeriod><espi:value>284</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720353600</espi:start></espi:timePeriod><espi:value>508</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720357200</espi:start></espi:timePeriod><espi:value>658</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720360800</espi:start></espi:timePeriod><espi:value>402</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720364400</espi:start></espi:timePeriod><espi:value>492</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720368000</espi:start></espi:timePeriod><espi:value>336</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720371600</espi:start></espi:timePeriod><espi:value>306</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720375200</espi:start></espi:timePeriod><espi:value>250</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720378800</espi:start></espi:timePeriod><espi:value>310</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720382400</espi:start></espi:timePeriod><espi:value>480</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720386000</espi:start></espi:timePeriod><espi:value>754</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720389600</espi:start></espi:timePeriod><espi:value>1004</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720393200</espi:start></espi:timePeriod><espi:value>858</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720396800</espi:start></espi:timePeriod><espi:value>658</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720400400</espi:start></espi:timePeriod><espi:value>412</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720404000</espi:start></espi:timePeriod><espi:value>312</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720407600</espi:start></espi:timePeriod><espi:value>206</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720411200</espi:start></espi:timePeriod><espi:value>178</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720414800</espi:start></espi:timePeriod><espi:value>203</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720418400</espi:start></espi:timePeriod><espi:value>162</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720422000</espi:start></espi:timePeriod><espi:value>20</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720425600</espi:start></espi:timePeriod><espi:value>156</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720429200</espi:start></espi:timePeriod><espi:value>201</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720432800</espi:start></espi:timePeriod><espi:value>290</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720436400</espi:start></espi:timePeriod><espi:value>540</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720440000</espi:start></espi:timePeriod><espi:value>790</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720443600</espi:start></espi:timePeriod><espi:value>474</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720447200</espi:start></espi:timePeriod><espi:value>324</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720450800</espi:start></espi:timePeriod><espi:value>248</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720454400</espi:start></espi:timePeriod><espi:value>258</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720458000</espi:start></espi:timePeriod><espi:value>232</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720461600</espi:start></espi:timePeriod><espi:value>292</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720465200</espi:start></espi:timePeriod><espi:value>306</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720468800</espi:start></espi:timePeriod><espi:value>526</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720472400</espi:start></espi:timePeriod><espi:value>850</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720476000</espi:start></espi:timePeriod><espi:value>1150</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720479600</espi:start></espi:timePeriod><espi:value>970</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720483200</espi:start></espi:timePeriod><espi:value>694</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720486800</espi:start></espi:timePeriod><espi:value>504</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720490400</espi:start></espi:timePeriod><espi:value>308</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720494000</espi:start></espi:timePeriod><espi:value>258</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720497600</espi:start></espi:timePeriod><espi:value>220</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720501200</espi:start></espi:timePeriod><espi:value>179</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720504800</espi:start></espi:timePeriod><espi:value>204</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720508400</espi:start></espi:timePeriod><espi:value>163</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720512000</espi:start></espi:timePeriod><espi:value>198</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720515600</espi:start></espi:timePeriod><espi:value>177</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720519200</espi:start></espi:timePeriod><espi:value>332</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720522800</espi:start></espi:timePeriod><espi:value>516</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720526400</espi:start></espi:timePeriod><espi:value>766</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720530000</espi:start></espi:timePeriod><espi:value>450</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720533600</espi:start></espi:timePeriod><espi:value>300</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720537200</espi:start></espi:timePeriod><espi:value>290</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720540800</espi:start></espi:timePeriod><espi:value>234</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720544400</espi:start></espi:timePeriod><espi:value>274</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720548000</espi:start></espi:timePeriod><espi:value>268</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720551600</espi:start></espi:timePeriod><espi:value>348</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720555200</espi:start></espi:timePeriod><espi:value>502</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720558800</espi:start></espi:timePeriod><espi:value>892</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720562400</espi:start></espi:timePeriod><espi:value>1126</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720566000</espi:start></espi:timePeriod><espi:value>946</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720569600</espi:start></espi:timePeriod><espi:value>670</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720573200</espi:start></espi:timePeriod><espi:value>480</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720576800</espi:start></espi:timePeriod><espi:value>350</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720580400</espi:start></espi:timePeriod><espi:value>234</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720584000</espi:start></espi:timePeriod><espi:value>196</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720587600</espi:start></espi:timePeriod><espi:value>155</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720591200</espi:start></espi:timePeriod><espi:value>180</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720594800</espi:start></espi:timePeriod><espi:value>205</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720598400</espi:start></espi:timePeriod><espi:value>174</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720602000</espi:start></espi:timePeriod><espi:value>219</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720605600</espi:start></espi:timePeriod><espi:value>308</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720609200</espi:start></espi:timePeriod><espi:value>558</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720612800</espi:start></espi:timePeriod><espi:value>742</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720616400</espi:start></espi:timePeriod><espi:value>492</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720620000</espi:start></espi:timePeriod><espi:value>276</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720623600</espi:start></espi:timePeriod><espi:value>266</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720627200</espi:start></espi:timePeriod><espi:value>210</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720630800</espi:start></espi:timePeriod><espi:value>250</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720634400</espi:start></espi:timePeriod><espi:value>310</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720638000</espi:start></espi:timePeriod><espi:value>324</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720641600</espi:start></espi:timePeriod><espi:value>544</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720645200</espi:start></espi:timePeriod><espi:value>868</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720648800</espi:start></espi:timePeriod><espi:value>1168</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720652400</espi:start></espi:timePeriod><espi:value>922</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720656000</espi:start></espi:timePeriod><espi:value>712</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720659600</espi:start></espi:timePeriod><espi:value>456</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720663200</espi:start></espi:timePeriod><espi:value>326</espi:value></espi:IntervalReading>
      <espi:IntervalReading><espi:timePeriod><espi:start>1720666800</espi:start></espi:timePeriod><espi:value>210</espi:value></espi:IntervalReading>
    </espi:IntervalBlock>
  </entry>
</feed>
"""


def load_sample_dataframe():
    """Parse the inline fixture with the production parser and return its DataFrame.

    ``parse_green_button_xml`` takes a path, so the inline string is written to a
    temporary file, parsed, and removed again. Works from any working directory --
    no ``electricit2024-now.xml`` required.
    """
    fd, tmp_path = tempfile.mkstemp(prefix="green_button_sample_", suffix=".xml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(SAMPLE_XML)
        return parse_green_button_xml(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

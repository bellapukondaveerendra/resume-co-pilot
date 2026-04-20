import axios from "axios";
import * as cheerio from "cheerio";

async function testJD(url) {
  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(html);

    // remove useless stuff
    $("script, style, nav, footer").remove();

    // extract raw text
    let text = $("body").text();

    text = text
      .replace(/\s+/g, " ")
      .trim();

    console.log("\n========== RAW JD (first 2000 chars) ==========\n");
    console.log(text.slice(0, 2000));

    console.log("\n========== LENGTH ==========\n");
    console.log(text.length);

  } catch (err) {
    console.error("Error:", err.message);
  }
}

// 👉 put your test URL here
testJD("https://apply.careers.microsoft.com/careers?query=Software&start=0&location=United+States%2C+Multiple+Locations%2C+Multiple+Locations&pid=1970393556751840&sort_by=match&filter_include_remote=1");
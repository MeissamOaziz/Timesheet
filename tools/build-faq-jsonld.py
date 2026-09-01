# Rebuilds the landing page's FAQPage structured data from FAQ_SALES.
#
# The hand-written block it replaces listed four questions — two French and two English inside
# a single FAQPage — which describes no page that actually exists, and picked duplicates rather
# than the questions prospects ask. Generating it from the same dictionary the page renders
# means the structured data cannot drift from the visible copy.
#
#   python tools/build-faq-jsonld.py           # rewrite index.html in place
#   python tools/build-faq-jsonld.py --check   # verify only, non-zero exit if stale
import io, re, sys, json, html, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PAGE = os.path.join(ROOT, 'index.html')

# Must match FAQ_SALES in index.html — the pre-sale subset of the FAQ.
SALES = [1, 2, 6, 7, 8, 24, 11, 12, 13, 15, 16, 19]
# Raised from 8 to 9 to fit q24 (the employee self-service portal) into the rich-result set
# without demoting any of the eight questions already curated here.
MAX = 9


def read_value(src, key):
    """Return the EN dictionary value for `key`.

    Scans to the closing quote stepping over backslash escapes, so an apostrophe inside the
    French-influenced copy ("l\\'employe") does not end the value early. A regex for this keeps
    tripping over its own escaping; this does not.
    """
    needle = "'" + key + "':'"
    i = src.find(needle)
    if i < 0:
        return None
    j = i + len(needle)
    out = []
    while j < len(src):
        c = src[j]
        if c == '\\':
            out.append(src[j + 1])
            j += 2
            continue
        if c == "'":
            break
        out.append(c)
        j += 1
    return ''.join(out)


def build(src):
    entries = []
    missing = []
    for n in SALES:
        q = read_value(src, 'faq.q%d' % n)
        a = read_value(src, 'faq.a%d' % n)
        if not q or not a:
            missing.append(n)
            continue
        # Answers carry markup for the accordion; structured data wants plain text.
        a = re.sub(r'<[^>]+>', '', a)
        entries.append({
            "@type": "Question",
            "name": html.unescape(q).strip(),
            "acceptedAnswer": {"@type": "Answer", "text": html.unescape(a).strip()},
        })
    return entries[:MAX], missing


def main():
    check = '--check' in sys.argv
    src = io.open(PAGE, encoding='utf-8').read()
    entries, missing = build(src)
    if missing:
        print('  missing FAQ copy for:', missing)
    if not entries:
        print('no FAQ copy resolved — refusing to write an empty block')
        return 1

    payload = json.dumps(
        {"@context": "https://schema.org", "@type": "FAQPage",
         "inLanguage": "en-CA", "mainEntity": entries},
        indent=2, ensure_ascii=False)
    block = '<script type="application/ld+json">\n' + payload + '\n</script>'

    i = src.index('FAQPage')
    start = src.rfind('<script', 0, i)
    end = src.index('</script>', i) + len('</script>')
    current = src[start:end]

    if current.strip() == block.strip():
        print('FAQ structured data is up to date (%d questions)' % len(entries))
        return 0
    if check:
        print('FAQ structured data is STALE — run: python tools/build-faq-jsonld.py')
        return 1

    io.open(PAGE, 'w', encoding='utf-8', newline='').write(src[:start] + block + src[end:])
    print('FAQ structured data rebuilt: %d questions, en-CA' % len(entries))
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""src/* 를 index.html 한 파일로 합친다 (오프라인에서 파일 하나만 있으면 동작)."""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def main():
    tpl = read('src/index.template.html')
    parts = {
        '/*STYLE*/': read('src/style.css').strip(),
        '/*RULES*/': read('src/rules.js').strip(),
        '/*STORE*/': read('src/store.js').strip(),
        '/*APP*/': read('src/app.js').strip(),
    }
    for name, body in parts.items():
        if '</script' in body.lower() and name != '/*STYLE*/':
            sys.exit('ERROR: %s 안에 </script 가 들어 있습니다' % name)

    out = tpl
    for name, body in parts.items():
        out = out.replace(name, body)
    for name in parts:
        if name in out:
            sys.exit('ERROR: 치환되지 않은 자리표시자 %s' % name)

    path = os.path.join(ROOT, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)
    print('built %s (%d bytes)' % (path, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()

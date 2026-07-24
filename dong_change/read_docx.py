import zipfile
import xml.etree.ElementTree as ET

path = r'C:\Users\xunyi\Desktop\posture-system\dong_change\改动.docx'
with zipfile.ZipFile(path) as z:
    xml_content = z.read('word/document.xml')

root = ET.fromstring(xml_content)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
texts = []
for t in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
    if t.text:
        texts.append(t.text)

print('\n'.join(texts))

import zipfile, xml.etree.ElementTree as ET
path = 'C:\\Users\\xunyi\\Desktop\\posture-system\\dong_change\\改动.docx'
with zipfile.ZipFile(path) as z:
    xml_content = z.read('word/document.xml')
root = ET.fromxml(xml_content)
text = []
for t in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
    if t.text:
        text.append(t.text)
print('\n'.join(text))

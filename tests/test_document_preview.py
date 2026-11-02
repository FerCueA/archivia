import base64,importlib.util,io,tempfile,unittest,zipfile
from pathlib import Path
from PIL import Image
spec=importlib.util.spec_from_file_location('preview',Path(__file__).resolve().parents[1]/'src/preview-render.py');preview=importlib.util.module_from_spec(spec);spec.loader.exec_module(preview)
def pdf():
 objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',b'<< /Length 35 >>\nstream\nBT /F1 12 Tf 20 100 Td (Test) Tj ET\nendstream',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];data=b'%PDF-1.4\n';offsets=[0]
 for i,obj in enumerate(objects,1):offsets.append(len(data));data+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
 start=len(data);data+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{x:010d} 00000 n \n'.encode() for x in offsets[1:]);data+=b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF';return data
class Preview(unittest.TestCase):
 def render(self,data,extension,page=1):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'snapshot';p.write_bytes(data);return preview.render(str(p),extension,page)
 def test_image_becomes_bounded_png(self):
  out=io.BytesIO();Image.new('RGB',(2000,1000),'red').save(out,format='JPEG');result=self.render(out.getvalue(),'.jpg');self.assertEqual(result['mime'],'image/png');im=Image.open(io.BytesIO(base64.b64decode(result['data'])));self.assertLessEqual(im.width,1600)
 def test_pdf_page_is_rasterized(self):
  result=self.render(pdf(),'.pdf');self.assertEqual(result['kind'],'image');self.assertEqual(result['pages'],1);self.assertTrue(base64.b64decode(result['data']).startswith(b'\x89PNG'))
 def test_docx_is_read_as_plain_text_without_extracting_zip_files(self):
  data=io.BytesIO()
  with zipfile.ZipFile(data,'w') as z:z.writestr('word/document.xml','<document><p><t>Hello document</t></p></document>');z.writestr('../escape','not extracted')
  result=self.render(data.getvalue(),'.docx');self.assertEqual(result['kind'],'text');self.assertIn('Hello document',result['text'])
  odt=io.BytesIO()
  with zipfile.ZipFile(odt,'w') as z:z.writestr('content.xml','<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Hello ODT</text:p></office:document-content>')
  self.assertIn('Hello ODT',self.render(odt.getvalue(),'.odt')['text'])
 def test_active_html_is_only_returned_as_text(self):
  result=self.render(b'<script>alert(1)</script>','.html');self.assertEqual(result['kind'],'text');self.assertIn('<script>',result['text'])
 def test_xml_entities_are_not_processed(self):
  data=io.BytesIO()
  with zipfile.ZipFile(data,'w') as z:z.writestr('word/document.xml','<!DOCTYPE test [<!ENTITY secret SYSTEM "file:///etc/passwd">]><p>&secret;</p>')
  with self.assertRaises(ValueError):self.render(data.getvalue(),'.docx')
if __name__=='__main__':unittest.main()

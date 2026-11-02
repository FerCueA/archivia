#!/usr/bin/env python3
"""Render bounded, inert previews. Input is a private verified snapshot."""
import base64,io,json,re,subprocess,sys,zipfile,xml.etree.ElementTree as ET
from pathlib import Path
LIMIT=20000

def render(filename,extension,page):
 data=Path(filename).read_bytes()
 if len(data)>32*1024**2:raise ValueError('El archivo supera el límite de 32 MiB para vistas previas.')
 if data.startswith(b'%PDF-'):
  try:
   info=subprocess.run(['/usr/bin/pdfinfo',filename],capture_output=True,timeout=10,check=True).stdout.decode('utf-8','replace')
   match=re.search(r'^Pages:\s+(\d+)',info,re.M);pages=int(match.group(1)) if match else 1
   page=max(1,min(page,pages));result=subprocess.run(['/usr/bin/pdftoppm','-f',str(page),'-l',str(page),'-singlefile','-scale-to','1400','-png',filename],capture_output=True,timeout=20,check=True)
   if len(result.stdout)>8*1024**2:raise ValueError('La imagen de esta página es demasiado grande.')
   return {'kind':'image','mime':'image/png','data':base64.b64encode(result.stdout).decode(),'page':page,'pages':pages,'caption':'Página de PDF'}
  except FileNotFoundError:raise ValueError('Falta Poppler (pdfinfo/pdftoppm) para mostrar PDF. Puedes abrir el archivo desde su carpeta.')
  except subprocess.SubprocessError:raise ValueError('No se puede mostrar este PDF; puede estar protegido o necesitar otra aplicación.')
 if extension in ('.docx','.docm','.odt') and data.startswith(b'PK'):
  with zipfile.ZipFile(io.BytesIO(data)) as archive:
   if len(archive.infolist())>5000:raise ValueError('Documento demasiado complejo para una vista previa.')
   member='content.xml' if extension=='.odt' else 'word/document.xml'
   info=archive.getinfo(member)
   if info.file_size>2*1024**2:raise ValueError('El texto del documento es demasiado grande para una vista previa.')
   xml=archive.read(member).decode('utf-8-sig')
   if re.search(r'<!DOCTYPE|<!ENTITY',xml,re.I):raise ValueError('El documento contiene declaraciones XML no admitidas.')
   tree=ET.fromstring(xml);paragraphs=[]
   for element in tree.iter():
    tag=element.tag.rsplit('}',1)[-1]
    if tag in ('p','h'):
     paragraphs.append(''.join(element.itertext()))
     if sum(map(len,paragraphs))>LIMIT:break
   text='\n'.join(paragraphs)
   return {'kind':'text','text':text[:LIMIT],'truncated':len(text)>LIMIT,'caption':'Texto del documento · sin formato de página'}
 if extension in ('.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff'):
  try:
   from PIL import Image,ImageOps
   Image.MAX_IMAGE_PIXELS=40000000
   with Image.open(io.BytesIO(data)) as img:
    if img.width*img.height>40000000:raise ValueError('La imagen supera el límite de 40 megapíxeles.')
    img.seek(0);img=ImageOps.exif_transpose(img);img.thumbnail((1600,1200));img=img.convert('RGBA');out=io.BytesIO();img.save(out,format='PNG');result=out.getvalue()
    if len(result)>8*1024**2:raise ValueError('La vista previa de esta imagen es demasiado grande.')
    return {'kind':'image','mime':'image/png','data':base64.b64encode(result).decode(),'page':1,'pages':1,'caption':'Imagen · primer fotograma si está animada'}
  except ImportError:raise ValueError('Falta Pillow para mostrar imágenes. Puedes abrirlas desde su carpeta.')
 if extension in ('.txt','.md','.csv','.json','.xml','.log','.ini','.yaml','.yml','.html','.css','.js','.ts','.py','.sh'):
  sample=data[:100000]
  if b'\0' in sample:raise ValueError('Este archivo no parece texto legible.')
  text=sample.decode('utf-8-sig','replace');return {'kind':'text','text':text[:LIMIT],'truncated':len(text)>LIMIT or len(data)>len(sample),'caption':'Texto sin ejecutar contenido activo'}
 return {'kind':'unsupported','message':'Vista previa disponible para PDF, imágenes, TXT, CSV, Markdown, DOCX y ODT. Usa Mostrar en carpeta para otros formatos.'}
if __name__=='__main__':
 try:
  import resource
  resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
 except Exception:pass
 try:print(json.dumps(render(sys.argv[1],sys.argv[2].lower(),int(sys.argv[3]))))
 except Exception as error:print(json.dumps({'kind':'unsupported','message':str(error) or 'No se puede generar una vista previa de este archivo.'}))

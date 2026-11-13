const fs = require('node:fs');
const path = require('node:path');

const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const PROOF_FORMATS = 'PNG, JPG, JPEG o HEIC de hasta 10 MB';
const INVALID_PROOF = 'Adjunta una imagen válida en formato ' + PROOF_FORMATS + '.';
const PROOF_EXTENSIONS = /\.(png|jpe?g|heic)$/i;

function isHeic(bytes) {
  const imageBrands = new Set(['heic', 'heix']);
  const supportedMajorBrands = new Set(['heic', 'heix', 'mif1']);
  if (bytes.length < 20 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  const end = bytes.readUInt32BE(0);
  if (end < 16 || end > bytes.length || end % 4 !== 0 || !supportedMajorBrands.has(bytes.toString('ascii', 8, 12))) return false;

  let hasImageBrand = imageBrands.has(bytes.toString('ascii', 8, 12));
  for (let offset = 16; offset < end; offset += 4) {
    if (imageBrands.has(bytes.toString('ascii', offset, offset + 4))) hasImageBrand = true;
  }
  if (!hasImageBrand) return false;

  let hasMetadata = false;
  for (let offset = end; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || size > bytes.length - offset) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'meta' && size > 12) hasMetadata = true;
    offset += size;
    if (offset === bytes.length) return hasMetadata;
  }
  return false;
}

function matchesFormat(bytes, extension) {
  if (bytes.length > MAX_PROOF_BYTES) return false;
  if (extension === '.png') {
    return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  return extension === '.heic' && isHeic(bytes);
}

function validScreenshot(req) {
  if (req.file) return matchesFormat(fs.readFileSync(req.file.path), path.extname(req.file.originalname).toLowerCase());
  const encoded = req.body.screenshot_base64;
  if (!encoded) return true;
  if (typeof encoded !== 'string') return false;
  const png = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(encoded);
  return Boolean(png && matchesFormat(Buffer.from(png[1], 'base64'), '.png'));
}

module.exports = { MAX_PROOF_BYTES, INVALID_PROOF, PROOF_EXTENSIONS, validScreenshot };

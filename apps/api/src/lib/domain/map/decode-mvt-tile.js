import { VectorTile } from "@mapbox/vector-tile";
import Protobuf from "pbf";

const MVT_EXTENT = 4096;

export function tilePointToLngLat(z, tileX, tileY, pointX, pointY, extent = MVT_EXTENT) {
  const worldX = tileX + pointX / extent;
  const worldY = tileY + pointY / extent;
  const lng = (worldX / 2 ** z) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / 2 ** z)));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

/** Decode MVT bytes into property features with WGS84 coordinates. */
export function decodePropertyMvtTile(bytes, z, x, y) {
  if (!bytes?.length) return [];

  const tile = new VectorTile(new Protobuf(bytes));
  const layer = tile.layers?.properties;
  if (!layer) return [];

  const features = [];
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    const geom = feature.loadGeometry();
    const props = feature.properties ?? {};
    const propertyId = String(props.property_id ?? "").trim();
    if (!propertyId) continue;

    let lng = null;
    let lat = null;
    const ring = geom?.[0];
    const pt = ring?.[0];
    if (pt) {
      [lng, lat] = tilePointToLngLat(z, x, y, pt.x, pt.y);
    }

    features.push({
      property_id: propertyId,
      marker_key: props.marker_key ?? null,
      market: props.market ?? null,
      contact_status: props.contact_status ?? null,
      longitude: lng,
      latitude: lat,
    });
  }

  return features;
}
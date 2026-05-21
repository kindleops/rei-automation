import fs from "fs";
const file = "src/modules/inbox/components/IntelligencePanel.tsx";
let content = fs.readFileSync(file, "utf8");

// Prospect Panel Changes:
// 1. AGE: value={(thread as any).prospect_age}
// 2. BUYING POWER: Add FieldTile
// 3. PHONE CARRIER: Add FieldTile
// 4. MARITAL STATUS: we will map it correctly based on the SQL view. (I will just pass them through).
content = content.replace(
  '<FieldTile label="Age" value={(thread as any).person_flags_json?.age} />',
  '<FieldTile label="Age" value={(thread as any).prospect_age} />'
);

content = content.replace(
  '<FieldTile label="Net Asset Value" value={(thread as any).net_asset_value} />',
  '<FieldTile label="Net Asset Value" value={(thread as any).net_asset_value} />\n          <FieldTile label="Buying Power" value={(thread as any).buying_power} />\n          <FieldTile label="Phone Carrier" value={(thread as any).phone_carrier} />'
);

// Portfolio Panel Changes:
// 1. SFR COUNT
// 2. MF COUNT
content = content.replace(
  '<FieldTile label="Portfolio Property Count" value={formatInteger(thread.property_count || 0)} />',
  '<FieldTile label="Portfolio Property Count" value={formatInteger(thread.property_count || 0)} />\n        <FieldTile label="SFR Count" value={formatInteger((thread as any).sfr_count || 0)} />\n        <FieldTile label="MF Count" value={formatInteger((thread as any).mf_count || 0)} />'
);

// Property Intel Overview:
// Remove FULL PROPERTY ADDRESS directly above property flags
content = content.replace(
  '<FieldTile label="Full Property Address" value={thread.displayAddress} />',
  ''
);

// Property Intel Location:
// Add MARKET, ADDRESS
// Let"s find Location section
content = content.replace(
  '<PanelSection title="Location Insights" icon="map">',
  '<PanelSection title="Location Insights" icon="map">\n      <FieldGrid>\n        <FieldTile label="Market" value={thread.displayMarket || thread.market} />\n        <FieldTile label="Address" value={thread.displayAddress} />\n      </FieldGrid>'
);

// Owner Panel:
// Needs to show full owner name not prospect.
content = content.replace(
  'title="Owner Operations" icon="user"',
  'title="Owner Operations" icon="user" header={thread.owner_display_name || thread.ownerName}'
);
content = content.replace(
  '<FieldTile label="Priority Tier" value={thread.owner_priority_tier || thread.priority} tone="accent" />',
  '<FieldTile label="Owner Name" value={thread.owner_display_name || thread.ownerName} tone="accent" />\n        <FieldTile label="Language" value={(thread as any).best_language} />\n        <FieldTile label="Priority Tier" value={thread.owner_priority_tier || thread.priority} tone="accent" />'
);

fs.writeFileSync(file, content);
console.log("Updated UI!");

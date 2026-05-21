import fs from 'fs';

console.log('🧪 Starting KPI UI Proof...\n');

const uiFile = 'src/modules/kpis/KpiIntelligencePage.tsx';

if (fs.existsSync(uiFile)) {
    const content = fs.readFileSync(uiFile, 'utf8');
    const requiredElements = [
        'nx-kpi-metric-grid',
        'nx-kpi-metric-card',
        'nx-kpi-filter-strip',
        'nx-kpi-recommendations',
        'Template Intelligence',
        'Number / Routing Intelligence'
    ];

    let passed = true;
    for (const el of requiredElements) {
        if (content.includes(el)) {
            console.log(`✅ UI element found: ${el}`);
        } else {
            console.error(`❌ UI element missing: ${el}`);
            passed = false;
        }
    }

    if (passed) {
        console.log('\n✨ KPI UI Proof Complete!');
        process.exit(0);
    } else {
        process.exit(1);
    }
} else {
    console.error('❌ UI file missing.');
    process.exit(1);
}

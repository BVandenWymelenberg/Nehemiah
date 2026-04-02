export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Only allow requests to known GIS servers
    const allowedDomains = [
        'gis.yavapaiaz.gov',
        'maps.mcassessor.maricopa.gov',
        'gismaps.coconino.az.gov',
        'gis.pima.gov',
        'gis.gilacountyaz.gov',
        'services1.arcgis.com',
        'services.arcgis.com',
        'maps.pinalcountyaz.gov',
        'gisweb.mohavecounty.us'
    ];

    try {
        const parsedUrl = new URL(url);
        if (!allowedDomains.some(d => parsedUrl.hostname.endsWith(d))) {
            return res.status(403).json({ error: 'Domain not allowed' });
        }

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Nehemiah-GIS-App/1.0'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
        }

        const data = await response.text();

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

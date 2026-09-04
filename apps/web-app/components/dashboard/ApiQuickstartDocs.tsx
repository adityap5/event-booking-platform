interface ApiQuickstartDocsProps {
  eventsApiUrl: string;
  organizationName: string;
}

export function ApiQuickstartDocs({ eventsApiUrl, organizationName }: ApiQuickstartDocsProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm mb-8">
      <div className="text-xl font-semibold mb-4">API Quickstart</div>
      <p className="text-gray-600 text-[0.9rem] mb-4">
        Use your API key as a Bearer token in the <code>Authorization</code> header. All requests return JSON scoped exclusively to {organizationName}.
      </p>

      <h4 className="text-[0.95rem] font-semibold mb-2">List Upcoming Events</h4>
      <pre className="bg-[#1e293b] text-[#f8fafc] p-4 rounded-lg font-mono text-[0.85rem] overflow-x-auto mb-4">
{`curl -X GET "${eventsApiUrl}?limit=50&offset=0" \\
  -H "Authorization: Bearer <your_api_key>"`}
      </pre>

      <h4 className="text-[0.95rem] font-semibold mb-2 mt-4">Get Single Event (With Live Seats)</h4>
      <pre className="bg-[#1e293b] text-[#f8fafc] p-4 rounded-lg font-mono text-[0.85rem] overflow-x-auto mb-4">
{`curl -X GET "${eventsApiUrl}/<event_id>" \\
  -H "Authorization: Bearer <your_api_key>"`}
      </pre>
    </div>
  );
}

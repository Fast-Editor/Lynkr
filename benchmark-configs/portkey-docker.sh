#!/bin/bash
# Run Portkey local AI Gateway with provider credentials injected

docker run -d \
  --name portkey-gateway \
  -p 8083:8787 \
  -e AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY}" \
  -e MOONSHOT_API_KEY="${MOONSHOT_API_KEY}" \
  portkeyai/gateway:latest

echo "Portkey gateway running on http://localhost:8083"
echo ""
echo "To use Azure OpenAI directly (no tier routing):"
echo "  curl http://localhost:8083/v1/chat/completions \\"
echo "    -H 'x-portkey-provider: azure-openai' \\"
echo "    -H 'x-portkey-api-key: \$PORTKEY_API_KEY' \\"
echo "    -H 'x-portkey-azure-resource-name: YOUR-RESOURCE' \\"
echo "    -H 'x-portkey-azure-deployment-id: gpt-4o' \\"
echo "    -H 'x-portkey-azure-api-version: 2024-08-01-preview' \\"
echo "    -d '{\"model\": \"gpt-4o\", \"messages\": [...]}'"
echo ""
echo "To use conditional routing config, pass:"
echo "  -H 'x-portkey-config: <base64-encoded portkey-config.json>'"

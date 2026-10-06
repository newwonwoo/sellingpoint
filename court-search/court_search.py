"""호환 진입점. 실제 구현은 search.py에 있습니다."""
import asyncio
from search import main
if __name__ == '__main__': asyncio.run(main())

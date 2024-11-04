import {
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { DriftClient } from '../driftClient';
import { ReferrerInfo } from '../types';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from '../addresses/pda';
import {
	getUserStatsFilter,
	getUserStatsIsReferredFilter,
	getUserStatsIsReferredOrReferrerFilter,
} from '../memcmp';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

const DEFAULT_PUBLIC_KEY = PublicKey.default.toBase58();

export class ReferrerMap {
	/**
	 * map from authority pubkey to ReferrerInfo.
	 * - if a user has not been entered into the map, the value is undefined
	 * - if a user has no referrer, the value is null
	 * - if a user has a referrer, the value is a ReferrerInfo object
	 */
	private referrerMap = new Map<string, ReferrerInfo | null>();
	private driftClient: DriftClient;
	private bulkAccountLoader: BulkAccountLoader;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void;

	/**
	 * Creates a new UserStatsMap instance.
	 *
	 * @param {DriftClient} driftClient - The DriftClient instance.
	 * @param {BulkAccountLoader} [bulkAccountLoader] - If not provided, a new BulkAccountLoader with polling disabled will be created.
	 */
	constructor(
		driftClient: DriftClient,
		bulkAccountLoader?: BulkAccountLoader,
		parallelSync?: boolean
	) {
		this.driftClient = driftClient;
		if (!bulkAccountLoader) {
			bulkAccountLoader = new BulkAccountLoader(
				driftClient.connection,
				driftClient.opts.commitment,
				0
			);
		}
		this.bulkAccountLoader = bulkAccountLoader;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
	}

	/**
	 * Subscribe to all UserStats accounts.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		await this.sync();
	}

	public has(authorityPublicKey: string): boolean {
		return this.referrerMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): ReferrerInfo | undefined {
		const info = this.referrerMap.get(authorityPublicKey);
		return info === null ? undefined : info;
	}

	public async addReferrerInfo(
		authority: string,
		referrerInfo?: ReferrerInfo | null
	) {
		if (referrerInfo || referrerInfo === null) {
			this.referrerMap.set(authority, referrerInfo);
		} else if (referrerInfo === undefined) {
			const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
				this.driftClient.program.programId,
				new PublicKey(authority)
			);
			const buffer = (
				await this.driftClient.connection.getAccountInfo(
					userStatsAccountPublicKey,
					'processed'
				)
			).data;

			const referrer = bs58.encode(buffer.subarray(40, 72));

			const referrerKey = new PublicKey(referrer);
			this.addReferrerInfo(
				authority,
				referrer === DEFAULT_PUBLIC_KEY
					? null
					: {
							referrer: getUserAccountPublicKeySync(
								this.driftClient.program.programId,
								referrerKey,
								0
							),
							referrerStats: getUserStatsAccountPublicKey(
								this.driftClient.program.programId,
								referrerKey
							),
					  }
			);
		}
	}

	/**
	 * Enforce that a UserStats will exist for the given authorityPublicKey,
	 * reading one from the blockchain if necessary.
	 * @param authorityPublicKey
	 * @returns
	 */
	public async mustGet(
		authorityPublicKey: string
	): Promise<ReferrerInfo | undefined> {
		if (!this.has(authorityPublicKey)) {
			await this.addReferrerInfo(authorityPublicKey);
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<ReferrerInfo | null> {
		return this.referrerMap.values();
	}

	public size(): number {
		return this.referrerMap.size;
	}

	public async sync(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		try {
			if (this.parallelSync) {
				await Promise.all([
					this.syncAll(),
					this.syncReferrer(getUserStatsIsReferredFilter()),
					this.syncReferrer(getUserStatsIsReferredOrReferrerFilter()),
				]);
			} else {
				await this.syncAll();
				await this.syncReferrer(getUserStatsIsReferredFilter());
				await this.syncReferrer(getUserStatsIsReferredOrReferrerFilter());
			}
		} catch (e) {
			console.error('error in referrerMap.sync', e);
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getUserStatsFilter()],
				encoding: 'base64',
				dataSlice: {
					offset: 0,
					length: 0,
				},
				withContext: true,
			},
		];

		const rpcJSONResponse: any =
			// @ts-ignore
			await this.driftClient.connection._rpcRequest(
				'getProgramAccounts',
				rpcRequestArgs
			);

		const rpcResponseAndContext: RpcResponseAndContext<
			Array<{
				pubkey: string;
				account: {
					data: [string, string];
				};
			}>
		> = rpcJSONResponse.result;

		for (const account of rpcResponseAndContext.value) {
			// only add if it isn't already in the map
			// so that if syncReferrer already set it, we dont overwrite
			if (!this.has(account.pubkey)) {
				this.addReferrerInfo(account.pubkey, null);
			}
		}
	}

	async syncReferrer(referrerFilter: MemcmpFilter): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getUserStatsFilter(), referrerFilter],
				encoding: 'base64',
				dataSlice: {
					offset: 0,
					length: 72,
				},
				withContext: true,
			},
		];

		const rpcJSONResponse: any =
			// @ts-ignore
			await this.driftClient.connection._rpcRequest(
				'getProgramAccounts',
				rpcRequestArgs
			);

		const rpcResponseAndContext: RpcResponseAndContext<
			Array<{
				pubkey: string;
				account: {
					data: [string, string];
				};
			}>
		> = rpcJSONResponse.result;

		const batchSize = 1000;
		for (let i = 0; i < rpcResponseAndContext.value.length; i += batchSize) {
			const batch = rpcResponseAndContext.value.slice(i, i + batchSize);
			await Promise.all(
				batch.map(async (programAccount) => {
					// @ts-ignore
					const buffer = Buffer.from(
						programAccount.account.data[0],
						programAccount.account.data[1]
					);
					const authority = bs58.encode(buffer.subarray(8, 40));
					const referrer = bs58.encode(buffer.subarray(40, 72));

					const referrerKey = new PublicKey(referrer);
					this.addReferrerInfo(
						authority,
						referrer === DEFAULT_PUBLIC_KEY
							? null
							: {
									referrer: getUserAccountPublicKeySync(
										this.driftClient.program.programId,
										referrerKey,
										0
									),
									referrerStats: getUserStatsAccountPublicKey(
										this.driftClient.program.programId,
										referrerKey
									),
							  }
					);
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	public async unsubscribe() {
		this.referrerMap.clear();
	}
}